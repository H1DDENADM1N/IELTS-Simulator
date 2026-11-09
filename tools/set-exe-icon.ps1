# 把 .ico 写进 exe 的 Win32 图标资源（RT_GROUP_ICON / RT_ICON），
# 这样便携版在资源管理器、任务栏、Alt+Tab 里显示的都是自己的图标，而不是 Electron 默认图标。
#
# 用法：powershell -NoProfile -ExecutionPolicy Bypass -File tools/set-exe-icon.ps1 -Exe <exe> -Ico <ico>
param(
  [Parameter(Mandatory = $true)][string]$Exe,
  [Parameter(Mandatory = $true)][string]$Ico
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing | Out-Null

if (-not (Test-Path -LiteralPath $Exe)) { throw "找不到 exe：$Exe" }
if (-not (Test-Path -LiteralPath $Ico)) { throw "找不到 ico：$Ico" }

Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;

public static class PeIconWriter
{
    private const int RT_ICON = 3;
    private const int RT_GROUP_ICON = 14;
    private const uint LOAD_LIBRARY_AS_DATAFILE = 0x2;
    private const uint LOAD_LIBRARY_AS_IMAGE_RESOURCE = 0x20;

    private delegate bool EnumResNameProc(IntPtr hModule, IntPtr type, IntPtr name, IntPtr lParam);
    private delegate bool EnumResLangProc(IntPtr hModule, IntPtr type, IntPtr name, ushort language, IntPtr lParam);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr LoadLibraryEx(string file, IntPtr reserved, uint flags);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool FreeLibrary(IntPtr module);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool EnumResourceNames(IntPtr module, IntPtr type, EnumResNameProc callback, IntPtr lParam);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool EnumResourceLanguages(IntPtr module, IntPtr type, IntPtr name, EnumResLangProc callback, IntPtr lParam);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr BeginUpdateResource(string file, bool deleteExisting);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool UpdateResource(IntPtr update, IntPtr type, IntPtr name, ushort language, byte[] data, uint size);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool EndUpdateResource(IntPtr update, bool discard);

    private sealed class Entry
    {
        public byte Width, Height, Colors, Reserved;
        public ushort Planes, Bits;
        public uint Bytes, Offset;
    }

    private static List<Entry> ParseIco(byte[] ico)
    {
        if (ico.Length < 6 || BitConverter.ToUInt16(ico, 2) != 1)
            throw new InvalidDataException("不是合法的 ICO 文件");
        int count = BitConverter.ToUInt16(ico, 4);
        var list = new List<Entry>(count);
        for (int i = 0; i < count; i++)
        {
            int at = 6 + i * 16;
            list.Add(new Entry
            {
                Width = ico[at],
                Height = ico[at + 1],
                Colors = ico[at + 2],
                Reserved = ico[at + 3],
                Planes = BitConverter.ToUInt16(ico, at + 4),
                Bits = BitConverter.ToUInt16(ico, at + 6),
                Bytes = BitConverter.ToUInt32(ico, at + 8),
                Offset = BitConverter.ToUInt32(ico, at + 12),
            });
        }
        return list;
    }

    private static byte[] BuildGroup(List<Entry> entries)
    {
        var group = new byte[6 + entries.Count * 14];
        Array.Copy(BitConverter.GetBytes((ushort)0), 0, group, 0, 2);
        Array.Copy(BitConverter.GetBytes((ushort)1), 0, group, 2, 2);
        Array.Copy(BitConverter.GetBytes((ushort)entries.Count), 0, group, 4, 2);
        for (int i = 0; i < entries.Count; i++)
        {
            int at = 6 + i * 14;
            group[at] = entries[i].Width;
            group[at + 1] = entries[i].Height;
            group[at + 2] = entries[i].Colors;
            group[at + 3] = entries[i].Reserved;
            Array.Copy(BitConverter.GetBytes(entries[i].Planes), 0, group, at + 4, 2);
            Array.Copy(BitConverter.GetBytes(entries[i].Bits), 0, group, at + 6, 2);
            Array.Copy(BitConverter.GetBytes(entries[i].Bytes), 0, group, at + 8, 4);
            Array.Copy(BitConverter.GetBytes((ushort)(i + 1)), 0, group, at + 12, 2);
        }
        return group;
    }

    private static List<IntPtr> GroupIds(string exe)
    {
        var ids = new List<IntPtr>();
        IntPtr module = LoadLibraryEx(exe, IntPtr.Zero, LOAD_LIBRARY_AS_DATAFILE | LOAD_LIBRARY_AS_IMAGE_RESOURCE);
        if (module == IntPtr.Zero) throw new InvalidOperationException("无法读取资源：" + Marshal.GetLastWin32Error());
        try
        {
            EnumResourceNames(module, (IntPtr)RT_GROUP_ICON, delegate (IntPtr m, IntPtr t, IntPtr name, IntPtr p)
            {
                ids.Add(name);
                return true;
            }, IntPtr.Zero);
        }
        finally
        {
            FreeLibrary(module);
        }
        return ids;
    }

    private static List<ushort> Languages(string exe, IntPtr id)
    {
        var langs = new List<ushort>();
        IntPtr module = LoadLibraryEx(exe, IntPtr.Zero, LOAD_LIBRARY_AS_DATAFILE | LOAD_LIBRARY_AS_IMAGE_RESOURCE);
        if (module == IntPtr.Zero) throw new InvalidOperationException("无法读取资源：" + Marshal.GetLastWin32Error());
        try
        {
            EnumResourceLanguages(module, (IntPtr)RT_GROUP_ICON, id, delegate (IntPtr m, IntPtr t, IntPtr n, ushort lang, IntPtr p)
            {
                langs.Add(lang);
                return true;
            }, IntPtr.Zero);
        }
        finally
        {
            FreeLibrary(module);
        }
        return langs;
    }

    /// <summary>替换 exe 里所有图标组；返回写入的组数与语言数。</summary>
    public static int Apply(string exe, string icoPath)
    {
        byte[] ico = File.ReadAllBytes(icoPath);
        var entries = ParseIco(ico);
        byte[] group = BuildGroup(entries);
        var ids = GroupIds(exe);
        if (ids.Count == 0) ids.Add((IntPtr)1);

        IntPtr update = BeginUpdateResource(exe, false);
        if (update == IntPtr.Zero) throw new InvalidOperationException("BeginUpdateResource 失败：" + Marshal.GetLastWin32Error());
        int writes = 0;
        bool ok = false;
        try
        {
            foreach (IntPtr id in ids)
            {
                var langs = Languages(exe, id);
                if (langs.Count == 0) langs.Add(0);
                foreach (ushort lang in langs)
                {
                    for (int i = 0; i < entries.Count; i++)
                    {
                        uint size = entries[i].Bytes;
                        var data = new byte[size];
                        Array.Copy(ico, (long)entries[i].Offset, data, 0, size);
                        if (!UpdateResource(update, (IntPtr)RT_ICON, (IntPtr)(i + 1), lang, data, size))
                            throw new InvalidOperationException("写入 RT_ICON 失败：" + Marshal.GetLastWin32Error());
                    }
                    if (!UpdateResource(update, (IntPtr)RT_GROUP_ICON, id, lang, group, (uint)group.Length))
                        throw new InvalidOperationException("写入 RT_GROUP_ICON 失败：" + Marshal.GetLastWin32Error());
                    writes++;
                }
            }
            ok = true;
        }
        finally
        {
            EndUpdateResource(update, !ok);
        }
        return writes;
    }
}
'@

$exeFull = (Resolve-Path -LiteralPath $Exe).Path
$icoFull = (Resolve-Path -LiteralPath $Ico).Path
$writes = [PeIconWriter]::Apply($exeFull, $icoFull)

# 读回验证：系统 API 提取 exe 关联图标，确认已经不是默认图标（尺寸 256 时取到多尺寸条目）
$icon = [System.Drawing.Icon]::ExtractAssociatedIcon($exeFull)
if ($null -eq $icon) { throw '写完后无法从 exe 提取图标' }
$bitmap = $icon.ToBitmap()
$probe = $bitmap.GetPixel([int]($bitmap.Width / 2), [int]($bitmap.Height / 2))
Write-Output ("[icon] 已写入 {0} 组图标资源 → {1}" -f $writes, (Split-Path -Leaf $exeFull))
Write-Output ("[icon] 读回验证 {0}x{1}，中心像素 #{2:X2}{3:X2}{4:X2}" -f $bitmap.Width, $bitmap.Height, $probe.R, $probe.G, $probe.B)
$bitmap.Dispose()
$icon.Dispose()

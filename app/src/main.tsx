import React from 'react'
import { createRoot } from 'react-dom/client'
import { loadBank } from './lib/bank'
import { initTextScale } from './lib/textscale'
import { initFontFace } from './lib/fontface'
import { App } from './App'
import './styles.css'
import './exam.css'

// 先把上次的字体和字号落到 html 上，首屏就按用户的选择排版
initFontFace()
initTextScale()

const container = document.getElementById('root')!
const root = createRoot(container)

root.render(<div className="boot">正在读取本地题库…</div>)

loadBank().then(
  () => root.render(<App />),
  (error) =>
    root.render(
      <div className="boot boot-error">
        <h1>无法启动</h1>
        <p>{String(error?.message || error)}</p>
        <p>请双击便携文件夹里的 ielts-simulator.exe 启动，不要直接打开 HTML 文件。</p>
      </div>,
    ),
)

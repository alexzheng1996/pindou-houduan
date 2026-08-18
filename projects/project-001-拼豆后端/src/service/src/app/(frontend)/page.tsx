import React from 'react'

import './styles.css'

// 文件开头说明：M0 本地验证入口，不提供用户业务功能或作品数据。
export default function HomePage() {
  return (
    <div className="home">
      <div className="content">
        <h1>PixoMosaic 后端基础验证</h1>
        <p>当前仅验证 Payload、PostgreSQL、健康检查和环境隔离，不提供用户业务功能。</p>
        <div className="links">
          <a
            className="admin"
            href="/admin"
            rel="noopener noreferrer"
            target="_blank"
          >
            Go to admin panel
          </a>
          <a className="docs" href="/health">查看健康检查</a>
        </div>
      </div>
    </div>
  )
}

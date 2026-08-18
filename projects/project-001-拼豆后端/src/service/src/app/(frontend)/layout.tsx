import React from 'react'
import './styles.css'

export const metadata = {
  description: 'PixoMosaic 后端本地基础验证环境。',
  title: 'PixoMosaic Backend M0',
}

export default async function RootLayout(props: { children: React.ReactNode }) {
  const { children } = props

  return (
    <html lang="en">
      <body>
        <main>{children}</main>
      </body>
    </html>
  )
}

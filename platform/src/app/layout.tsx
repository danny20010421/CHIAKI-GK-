export const metadata = { title: 'CHIAKI', description: 'CHIAKI 線上一番賞（開發中）' };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-Hant">
      <body style={{ margin: 0, background: '#0b0b0c', color: '#e8e2d4', fontFamily: 'system-ui, sans-serif' }}>{children}</body>
    </html>
  );
}

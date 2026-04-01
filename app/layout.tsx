import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Sound Recorder - Voice Memo",
  description: "Windows 2000 style voice memo recorder",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="h-full">
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}

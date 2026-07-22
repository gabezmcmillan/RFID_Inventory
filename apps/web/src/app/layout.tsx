import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "RFID Inventory",
  description: "RFID inventory web app",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}

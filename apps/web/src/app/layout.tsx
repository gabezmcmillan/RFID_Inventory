import type { Metadata } from "next";
import "./globals.css";

import { Providers } from "./providers";

export const metadata: Metadata = {
  title: "RFID Inventory",
  description: "RFID inventory web app",
};

/** Adds the `dark` class to <html> from the OS color scheme before hydration,
 * so shadcn's class-based dark variant tracks the system preference (the prior
 * hand-rolled CSS used a prefers-color-scheme media query). Runs before React
 * to avoid a flash; `suppressHydrationWarning` covers the class mismatch. */
const themeScript = `try{if(window.matchMedia('(prefers-color-scheme: dark)').matches){document.documentElement.classList.add('dark')}}catch(e){}`;

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body className="min-h-screen flex flex-col">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}

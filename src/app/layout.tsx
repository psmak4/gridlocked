import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Gridlocked",
  description: "An unofficial F1 fan community and fantasy game.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}

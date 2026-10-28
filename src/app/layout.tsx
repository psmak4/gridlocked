import type { Metadata } from "next";
import { Anton, Barlow, Barlow_Semi_Condensed } from "next/font/google";
import "./globals.css";

const anton = Anton({
  weight: "400",
  subsets: ["latin"],
  display: "swap",
  variable: "--font-anton",
});

const barlow = Barlow({
  weight: ["400", "500", "600", "700"],
  subsets: ["latin"],
  display: "swap",
  variable: "--font-barlow",
});

const barlowSemi = Barlow_Semi_Condensed({
  weight: ["500", "600", "700"],
  subsets: ["latin"],
  display: "swap",
  variable: "--font-barlow-semi",
});

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
    <html
      lang="en"
      className={`${anton.variable} ${barlow.variable} ${barlowSemi.variable}`}
    >
      <body>{children}</body>
    </html>
  );
}

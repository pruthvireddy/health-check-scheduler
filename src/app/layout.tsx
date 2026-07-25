import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Health Check Scheduler",
  description: "A local-first conversational specialist routing and scheduling prototype.",
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

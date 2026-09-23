import type { Metadata } from "next";
import "./globals.css";
export const metadata: Metadata = {
  title: {
    default: "SOUTHWOODS CABLE and Internet",
    template: "%s · SOUTHWOODS CABLE and Internet",
  },
  description: "Subscriber, service and billing operations for your ISP.",
  robots: { index: false, follow: false },
  icons: { icon: "/icon.svg" },
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

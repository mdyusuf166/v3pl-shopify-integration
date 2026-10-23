import type { Metadata } from "next";
import { Inter } from "next/font/google";
import { Suspense } from "react";
import { NavigationProgress } from "@/components/layout/navigation-progress";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import "./globals.css";

/** Inter everywhere (D-056): one UI font, no display face; code/SKUs use the system monospace stack. */
const inter = Inter({ variable: "--font-inter", subsets: ["latin"], display: "swap" });

export const metadata: Metadata = {
  title: { default: "V3PL", template: "%s · V3PL" },
  description: "Vendor, 3PL, warehouse, inventory and order management platform",
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${inter.variable} h-full antialiased`}>
      <body className="min-h-full flex flex-col bg-background text-foreground">
        <Suspense fallback={null}>
          <NavigationProgress />
        </Suspense>
        <TooltipProvider>{children}</TooltipProvider>
        <Toaster position="top-right" richColors closeButton />
      </body>
    </html>
  );
}

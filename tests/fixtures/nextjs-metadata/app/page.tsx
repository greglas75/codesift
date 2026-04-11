export const metadata = {
  title: "Acme Storefront — Premium Goods",
  description:
    "Shop premium goods with worldwide shipping, 30-day returns, and 24/7 support.",
  openGraph: {
    title: "Acme Storefront",
    description: "Shop the best premium goods.",
    images: ["/og/home.jpg"],
  },
  twitter: {
    card: "summary_large_image",
  },
  alternates: {
    canonical: "/",
  },
  other: {
    "application/ld+json": "{}",
  },
};

export default function HomePage() {
  return <div>Welcome</div>;
}

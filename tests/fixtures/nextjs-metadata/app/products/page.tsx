export const metadata = {
  title: "Acme Products — All Categories",
  description:
    "Browse all Acme products: tents, packs, lights, stoves, and apparel for outdoor adventurers.",
  openGraph: {
    images: ["/og-image.png"],
  },
  twitter: {
    card: "summary",
  },
  alternates: {
    canonical: "/products",
  },
  other: {
    "application/ld+json": "{}",
  },
};

export default function ProductsPage() {
  return <div>Products</div>;
}

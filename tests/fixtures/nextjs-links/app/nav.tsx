import Link from "next/link";

export default function Nav({ id }: { id: string }) {
  const goToDashboard = () => router.push("/dashboard");
  return (
    <nav>
      <Link href="/about">About</Link>
      <Link href="/products/123">Product</Link>
      <Link href="/nonexistent">Broken</Link>
      <Link href={`/users/${id}`}>User</Link>
      <button onClick={goToDashboard}>Dashboard</button>
    </nav>
  );
}

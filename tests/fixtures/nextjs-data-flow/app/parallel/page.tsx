export default async function ParallelPage() {
  const [a, b] = await Promise.all([
    fetch("/api/a"),
    fetch("/api/b"),
  ]);
  return <div>{a.toString() + b.toString()}</div>;
}

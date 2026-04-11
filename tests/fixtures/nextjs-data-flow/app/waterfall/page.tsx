export default async function WaterfallPage() {
  const a = await fetch("/api/a");
  const b = await fetch("/api/b");
  return <div>{a.toString() + b.toString()}</div>;
}

"use client";

// Violation: async function with "use client" is not valid
export default async function AsyncClient() {
  const data = await fetch("/api/data");
  return <div>{JSON.stringify(data)}</div>;
}

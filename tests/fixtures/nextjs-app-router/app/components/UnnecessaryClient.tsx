"use client";

// This component has "use client" but doesn't use any client-side features.
// It should be flagged as unnecessary_use_client.
export function UnnecessaryClient({ message }: { message: string }) {
  return <div>{message}</div>;
}

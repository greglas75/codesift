// Linear 3-level chain: Root → Middle → Leaf, depth(Leaf) = 2
export function Leaf({ message }: { message: string }) {
  return <span>{message}</span>;
}

export function Middle({ message }: { message: string }) {
  return <Leaf message={message} />;
}

export function Root() {
  return <Middle message="hello" />;
}

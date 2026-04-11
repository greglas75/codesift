export default function ProductPage({ params }: { params: { id: string } }) {
  return <div>Product {params.id}</div>;
}

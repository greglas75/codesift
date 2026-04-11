import type { GetServerSideProps } from "next";

export const getServerSideProps: GetServerSideProps = async () => {
  return { props: {} };
};

export default function ProductPage() {
  return <div>Product</div>;
}

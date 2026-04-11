import type { GetServerSideProps } from "next";

export const getServerSideProps: GetServerSideProps = async () => {
  return { props: { data: "ssr" } };
};

export default function SsrPage() {
  return <div>SSR</div>;
}

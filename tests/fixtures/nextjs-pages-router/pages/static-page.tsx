import type { GetStaticProps } from "next";

export const getStaticProps: GetStaticProps = async () => {
  return { props: { data: "static" } };
};

export default function StaticPage() {
  return <div>Static</div>;
}

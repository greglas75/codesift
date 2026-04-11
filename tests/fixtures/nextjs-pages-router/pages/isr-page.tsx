import type { GetStaticProps } from "next";

export const getStaticProps: GetStaticProps = async () => {
  return { props: { data: "isr" }, revalidate: 60 };
};

export default function IsrPage() {
  return <div>ISR</div>;
}

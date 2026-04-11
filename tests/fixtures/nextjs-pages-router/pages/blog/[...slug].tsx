import type { GetStaticProps } from "next";

export const getStaticProps: GetStaticProps = async () => {
  return { props: {} };
};

export default function BlogPost() {
  return <div>Blog post</div>;
}

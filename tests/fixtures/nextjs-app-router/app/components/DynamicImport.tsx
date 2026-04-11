import dynamic from "next/dynamic";

const HeavyComponent = dynamic(() => import("./ClientButton"), { ssr: false });

export default function DynamicImportPage() {
  return <HeavyComponent />;
}

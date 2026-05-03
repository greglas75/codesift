// Recursive component: TreeNode renders TreeNode (cycle)
interface TreeData {
  label: string;
  children?: TreeData[];
}

export function TreeNode({ data }: { data: TreeData }) {
  return (
    <div>
      <span>{data.label}</span>
      {data.children?.map((c, i) => <TreeNode key={i} data={c} />)}
    </div>
  );
}

export function TreeRoot({ tree }: { tree: TreeData }) {
  return <TreeNode data={tree} />;
}

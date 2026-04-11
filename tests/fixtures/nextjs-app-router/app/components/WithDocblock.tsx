/**
 * This component has a long docblock but the "use client" directive
 * should still be detected within the 512-byte window.
 *
 * @module WithDocblock
 * @description A client component with documentation
 */
"use client";

import { useEffect } from "react";

export function WithDocblock() {
  useEffect(() => {
    console.log("mounted");
  }, []);
  return <div>Docblock component</div>;
}

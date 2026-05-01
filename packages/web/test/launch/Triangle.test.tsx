/// Regression test for the bugbot finding that two same-size `<Triangle>`
/// instances rendered on one page would share the same gradient id —
/// causing one instance's gradient to vanish if the other unmounted.
///
/// React's `useId()` guarantees unique ids per call site. We render
/// multiple Triangles with identical `size` and assert each `<linearGradient
/// id>` is distinct.

import {render} from "@testing-library/react";
import {describe, expect, it} from "vitest";

import {Triangle} from "@/components/launch/Triangle";

describe("Triangle", () => {
  it("emits unique gradient ids for sibling instances of the same size", () => {
    const {container} = render(
      <div>
        <Triangle size={32} />
        <Triangle size={32} />
        <Triangle size={32} />
      </div>,
    );
    const gradients = container.querySelectorAll("linearGradient");
    expect(gradients.length).toBe(3);
    const ids = Array.from(gradients).map((g) => g.id);
    expect(new Set(ids).size).toBe(3);
  });

  it("each path's fill references its own gradient", () => {
    const {container} = render(
      <div>
        <Triangle size={16} />
        <Triangle size={16} />
      </div>,
    );
    const paths = container.querySelectorAll("path");
    const gradients = container.querySelectorAll("linearGradient");
    expect(paths.length).toBe(2);
    paths.forEach((p, i) => {
      expect(p.getAttribute("fill")).toBe(`url(#${gradients[i]!.id})`);
    });
  });
});

import type { AstroTemplateParse, ComponentUsage, Directive, Island, SectionLandmark, Slot } from "./types.js";
import { asSectionLandmark, isSectionLandmark } from "./resolution.js";

const VOID_TAGS = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);

export class TemplateState {
  private readonly tagStack: string[] = [];
  private readonly sectionStack: SectionLandmark[] = [];
  private readonly islands: Island[] = [];
  private readonly slots: Slot[] = [];
  private readonly components: ComponentUsage[] = [];
  private readonly directives: Directive[] = [];
  private order = 0;

  close(tag: string): void {
    const index = this.tagStack.lastIndexOf(tag);
    if (index < 0) return;
    this.tagStack.splice(index, 1);
    if (isSectionLandmark(tag)) {
      const sectionIndex = this.sectionStack.lastIndexOf(asSectionLandmark(tag));
      if (sectionIndex >= 0) this.sectionStack.splice(sectionIndex, 1);
    }
  }

  open(tag: string, selfClose: boolean): void {
    if (selfClose || VOID_TAGS.has(tag)) return;
    this.tagStack.push(tag);
    if (isSectionLandmark(tag)) this.sectionStack.push(asSectionLandmark(tag));
  }

  context(): { parentTag: string | undefined; section: Island["is_inside_section"] } {
    return {
      parentTag: this.tagStack.length > 0 ? this.tagStack[this.tagStack.length - 1] : undefined,
      section: this.sectionStack.length > 0 ? this.sectionStack[this.sectionStack.length - 1] : null,
    };
  }

  addSlot(slot: Slot): void { this.slots.push(slot); }
  addComponent(component: ComponentUsage): void { this.components.push(component); }
  addDirective(directive: Directive): void { this.directives.push(directive); }
  addIsland(island: Omit<Island, "document_order">): void {
    this.islands.push({ ...island, document_order: this.order++ });
  }

  result(): AstroTemplateParse {
    return {
      islands: this.islands, slots: this.slots, component_usages: this.components,
      directives: this.directives, parse_confidence: "high", scan_errors: [],
    };
  }
}

import { Component, type ReactNode } from "react";

/** Keeps one broken piece of the HUD from taking the whole screen with it: it draws nothing in its place. */
export class Safe extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}
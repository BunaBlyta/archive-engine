import { Component, type ErrorInfo, type ReactNode } from "react";
import { Button } from "./ui/button";

type Props = { children: ReactNode };
type State = { error: Error | null };

// Without this, a single render error anywhere in the tree unmounts the whole app and leaves a
// blank white page with no way back but a manual reload. React has no hook equivalent — an error
// boundary has to be a class component.
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Keep the stack in the console: the visible message is deliberately plain, and without this
    // the only record of what actually broke would be gone.
    console.error("Unhandled UI error", error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;

    return (
      <div className="grid min-h-screen place-items-center bg-surface px-4">
        <div className="w-full max-w-md rounded-2xl bg-white p-6 text-center">
          <h1 className="font-display text-xl">Something went wrong</h1>
          <p className="mt-2 text-sm text-neutral-600">
            The page hit an unexpected error. Your work is saved on the server — reloading should
            pick up where you left off.
          </p>
          <p className="mt-3 break-words text-xs text-neutral-400">{this.state.error.message}</p>
          <Button className="mt-5" onClick={() => window.location.reload()} type="button">
            Reload
          </Button>
        </div>
      </div>
    );
  }
}

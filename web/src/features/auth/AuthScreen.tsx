import { api } from "../../api/client";
import type { UserRef } from "../../api/types";
import logoIcon from "../../assets/logo-icon.png";
import { Field } from "../../components/Field";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Tabs, TabsList, TabsTrigger } from "../../components/ui/tabs";
import { errorMessage } from "../../lib/format";
import { Archive, Loader2, Shield } from "lucide-react";
import { useState } from "react";
import type { FormEvent } from "react";

export function AuthScreen({
  onAuthed,
  onError,
}: {
  onAuthed: (token: string, user: UserRef) => Promise<void>;
  onError: (message: string) => void;
}) {
  const [mode, setMode] = useState("login");
  const [email, setEmail] = useState("test@example.com");
  const [password, setPassword] = useState("password123");
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      const data = mode === "login"
        ? await api.login(email, password)
        : await api.register(email, password, firstName, lastName);
      await onAuthed(data.accessToken, data.user);
    } catch (error) {
      onError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="grid min-h-screen place-items-center px-4">
      <form onSubmit={submit} className="w-full max-w-sm rounded-lg border border-neutral-100 bg-white p-6">
        <div className="mb-6 flex items-center gap-3">
          <img src={logoIcon} alt="" className="h-10 w-10" />
          <div>
            <h1 className="text-lg">Archive Engine</h1>
            <p className="text-sm text-neutral-500">Sign in to manage document versions.</p>
          </div>
        </div>
        <Tabs value={mode} onValueChange={setMode} className="mb-5">
          <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger value="login">Login</TabsTrigger>
            <TabsTrigger value="register">Register</TabsTrigger>
          </TabsList>
        </Tabs>
        <div className="space-y-4">
          {mode === "register" ? (
            <div className="grid grid-cols-2 gap-3">
              <Field label="First name">
                <Input value={firstName} onChange={(event) => setFirstName(event.target.value)} autoComplete="given-name" required />
              </Field>
              <Field label="Last name">
                <Input value={lastName} onChange={(event) => setLastName(event.target.value)} autoComplete="family-name" required />
              </Field>
            </div>
          ) : null}
          <Field label="Email">
            <Input value={email} onChange={(event) => setEmail(event.target.value)} type="email" autoComplete="email" required />
          </Field>
          <Field label="Password">
            <Input value={password} onChange={(event) => setPassword(event.target.value)} type="password" autoComplete={mode === "login" ? "current-password" : "new-password"} required />
          </Field>
          <Button className="w-full" disabled={busy}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Shield className="h-4 w-4" />}
            {mode === "login" ? "Sign in" : "Create account"}
          </Button>
        </div>
      </form>
    </section>
  );
}

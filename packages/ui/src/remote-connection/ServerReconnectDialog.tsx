import { useState } from "react";
import { Button } from "@/components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { Input } from "@/components/ui/input.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

export function ServerReconnectDialog({
  serverUrl,
  onSubmit,
  onCancel,
}: {
  serverUrl: string;
  onSubmit: (token: string) => void;
  onCancel: () => void;
}) {
  const { intl } = useZCodeIntl();
  const [token, setToken] = useState("");
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) {
          setToken("");
          onCancel();
        }
      }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{intl.formatMessage({ id: "server.reconnect.title" })}</DialogTitle>
          <DialogDescription>
            {intl.formatMessage({ id: "server.reconnect.description" })}
          </DialogDescription>
        </DialogHeader>
        <p className="break-all text-ui-sm text-foreground-subtle">{serverUrl}</p>
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            const credential = token;
            setToken("");
            onSubmit(credential);
          }}
        >
          <div className="space-y-2">
            <label htmlFor="server-reconnect-token">
              {intl.formatMessage({ id: "server.token" })}
            </label>
            <Input
              id="server-reconnect-token"
              type="password"
              autoComplete="off"
              autoFocus
              value={token}
              onChange={(event) => setToken(event.target.value)}
              placeholder={intl.formatMessage({ id: "server.tokenPlaceholder" })}
            />
          </div>
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="secondary"
              onClick={() => {
                setToken("");
                onCancel();
              }}
            >
              {intl.formatMessage({ id: "common.cancel" })}
            </Button>
            <Button type="submit">
              {intl.formatMessage({ id: "workspaceSidebar.reconnect" })}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

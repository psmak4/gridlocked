/**
 * The seam to the email provider. The outbox only knows this interface;
 * `resend.ts` is the one adapter. Error messages here are fixed text: they
 * never carry an address, a link or a provider's response (the Actions logs
 * are public).
 */
export interface EmailSender {
  send(message: {
    /** The outbox id, so a crash between send and update can't send twice. */
    idempotencyKey: string;
    to: string;
    subject: string;
    text: string;
    html: string;
  }): Promise<{ id: string }>;
}

/** The address is bad: don't retry. */
export class EmailRejectedError extends Error {
  constructor() {
    super("The email provider rejected the message");
    this.name = "EmailRejectedError";
  }
}

/** The provider says we are over quota: stop sending until the next day. */
export class EmailCapError extends Error {
  constructor() {
    super("The email provider's quota is used up");
    this.name = "EmailCapError";
  }
}

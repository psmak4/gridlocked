-- audit_log is append-only (DM 6.6): a mistaken action is fixed by a new
-- action, never by editing the log.
CREATE FUNCTION "audit_log_append_only"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only: % refused', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "audit_log_append_only"
  BEFORE UPDATE OR DELETE ON "audit_log"
  FOR EACH ROW EXECUTE FUNCTION "audit_log_append_only"();

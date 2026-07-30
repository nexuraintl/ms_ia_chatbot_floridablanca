import { Button } from "../atoms/Button";

export const QuickReplies = ({ replies, onSelect }) => {
  if (!replies || replies.length === 0) return null;

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "8px",
        padding: "6px 0",
        margin: "6px 0",
        width: "100%",
        boxSizing: "border-box",
        backgroundColor: "transparent"
      }}
      className="quick-replies-container animate-fade-in"
    >
      {replies.map((reply, index) => (
        <Button
          key={index}
          variant="secondary"
          onClick={() => onSelect(reply)}
          style={{
            justifyContent: "flex-start",
            textAlign: "left",
            fontSize: "0.92rem",
            fontWeight: "500",
            padding: "10px 14px",
            borderRadius: "12px",
            border: "1.5px solid var(--quick-reply-border)",
            backgroundColor: "transparent",
            color: "var(--quick-reply-text)",
            boxShadow: "none"
          }}
        >
          {reply}
        </Button>
      ))}
    </div>
  );
};

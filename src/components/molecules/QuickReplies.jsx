import React from "react";
import { Button } from "../atoms/Button";

export const QuickReplies = ({ replies, onSelect }) => {
  if (!replies || replies.length === 0) return null;

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "8px",
        padding: "8px 12px",
        width: "100%",
        boxSizing: "border-box"
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
            fontSize: "0.85rem",
            padding: "8px 12px",
            border: "1px solid rgba(74, 222, 128, 0.15)", // Acento verde sutil
            backgroundColor: "rgba(21, 128, 61, 0.05)",
            color: "#e2e8f0"
          }}
        >
          {reply}
        </Button>
      ))}
    </div>
  );
};

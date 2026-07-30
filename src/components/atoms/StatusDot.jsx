export const StatusDot = ({ online = true }) => {
  return (
    <span style={{ position: "relative", display: "flex", alignItems: "center" }}>
      <span
        style={{
          width: "8px",
          height: "8px",
          borderRadius: "50%",
          backgroundColor: online ? "#10b981" : "#9ca3af",
          display: "inline-block",
          animation: online ? "pulse-dot 2s infinite" : "none"
        }}
      />
      <style>{`
        @keyframes pulse-dot {
          0% {
            transform: scale(0.95);
            box-shadow: 0 0 0 0 rgba(16, 185, 129, 0.7);
          }
          70% {
            transform: scale(1);
            box-shadow: 0 0 0 6px rgba(16, 185, 129, 0);
          }
          100% {
            transform: scale(0.95);
            box-shadow: 0 0 0 0 rgba(16, 185, 129, 0);
          }
        }
      `}</style>
    </span>
  );
};

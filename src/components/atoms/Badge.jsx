export const Badge = ({ children, variant = "primary" }) => {
  const getStyles = () => {
    switch (variant) {
      case "success":
        return {
          backgroundColor: "rgba(16, 185, 129, 0.15)",
          color: "#34d399",
          border: "1px solid rgba(16, 185, 129, 0.3)"
        };
      case "info":
        return {
          backgroundColor: "rgba(59, 130, 246, 0.15)",
          color: "#60a5fa",
          border: "1px solid rgba(59, 130, 246, 0.3)"
        };
      case "warning":
        return {
          backgroundColor: "rgba(245, 158, 11, 0.15)",
          color: "#fbbf24",
          border: "1px solid rgba(245, 158, 11, 0.3)"
        };
      default:
        return {
          backgroundColor: "rgba(16, 124, 65, 0.15)", 
          color: "#4ade80",
          border: "1px solid rgba(16, 124, 65, 0.3)"
        };
    }
  };

  return (
    <span
      style={{
        padding: "2px 8px",
        borderRadius: "12px",
        fontSize: "0.75rem",
        fontWeight: "600",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        textTransform: "uppercase",
        letterSpacing: "0.05em",
        ...getStyles()
      }}
    >
      {children}
    </span>
  );
};

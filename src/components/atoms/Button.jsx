export const Button = ({
  children,
  onClick,
  type = "button",
  variant = "primary",
  disabled = false,
  fullWidth = false,
  size = "md",
  style = {}
}) => {
  const getStyles = () => {
    let base = {
      display: "inline-flex",
      alignItems: "center",
      justifyContent: "center",
      fontFamily: "inherit",
      fontWeight: "500",
      borderRadius: "8px",
      border: "none",
      cursor: disabled ? "not-allowed" : "pointer",
      opacity: disabled ? 0.6 : 1,
      transition: "all 0.2s cubic-bezier(0.4, 0, 0.2, 1)",
      width: fullWidth ? "100%" : "auto",
      outline: "none"
    };

    // Tamaños
    let sizeStyle;
    if (size === "sm") {
      sizeStyle = { padding: "6px 12px", fontSize: "0.85rem" };
    } else if (size === "lg") {
      sizeStyle = { padding: "12px 24px", fontSize: "1rem" };
    } else {
      sizeStyle = { padding: "8px 16px", fontSize: "0.9rem" };
    }

    // Variantes
    let variantStyle = {};
    if (variant === "primary") {
      variantStyle = {
        backgroundColor: "#15803d", // Verde El Retiro
        color: "#ffffff",
        boxShadow: "0 2px 4px rgba(21, 128, 61, 0.2)",
      };
    } else if (variant === "secondary") {
      variantStyle = {
        backgroundColor: "rgba(255, 255, 255, 0.08)",
        color: "#f3f4f6",
        border: "1px solid rgba(255, 255, 255, 0.1)",
      };
    } else if (variant === "accent") {
      variantStyle = {
        backgroundColor: "#d97706", // Ámbar/dorado de la madera
        color: "#ffffff",
        boxShadow: "0 2px 4px rgba(217, 119, 6, 0.2)",
      };
    } else if (variant === "ghost") {
      variantStyle = {
        backgroundColor: "transparent",
        color: "#9ca3af",
      };
    } else if (variant === "danger") {
      variantStyle = {
        backgroundColor: "#ef4444",
        color: "#ffffff",
      };
    }

    return { ...base, ...sizeStyle, ...variantStyle, ...style };
  };

  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      style={getStyles()}
      className={`btn-interactive ${variant}`}
    >
      {children}
    </button>
  );
};

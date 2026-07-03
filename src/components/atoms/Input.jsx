import React from "react";

export const Input = ({
  value,
  onChange,
  placeholder,
  type = "text",
  required = false,
  disabled = false,
  name,
  style = {}
}) => {
  return (
    <input
      type={type}
      value={value}
      onChange={onChange}
      placeholder={placeholder}
      required={required}
      disabled={disabled}
      name={name}
      style={{
        width: "100%",
        padding: "10px 14px",
        borderRadius: "8px",
        border: "1px solid rgba(255, 255, 255, 0.12)",
        backgroundColor: "rgba(255, 255, 255, 0.04)",
        color: "#ffffff",
        fontSize: "0.9rem",
        outline: "none",
        transition: "all 0.25s cubic-bezier(0.4, 0, 0.2, 1)",
        boxSizing: "border-box",
        fontFamily: "inherit",
        ...style
      }}
      className="input-premium"
    />
  );
};

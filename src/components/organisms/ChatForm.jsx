import React, { useState } from "react";
import { Input } from "../atoms/Input";
import { Button } from "../atoms/Button";

export const ChatForm = ({ formType, fields, onSubmit }) => {
  const [formData, setFormData] = useState(
    fields.reduce((acc, field) => ({ ...acc, [field.name]: "" }), {})
  );
  const [isSubmitted, setIsSubmitted] = useState(false);

  const handleChange = (e) => {
    const { name, value } = e.target;
    setFormData((prev) => ({ ...prev, [name]: value }));
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    setIsSubmitted(true);
    onSubmit(formType, formData);
  };

  return (
    <form
      onSubmit={handleSubmit}
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "10px",
        marginTop: "8px",
        width: "100%",
        boxSizing: "border-box"
      }}
    >
      {fields.map((field, idx) => (
        <div key={idx} style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
          <Input
            type={field.type}
            name={field.name}
            value={formData[field.name]}
            onChange={handleChange}
            placeholder={field.placeholder}
            required={field.required}
            disabled={isSubmitted}
            style={{
              fontSize: "0.85rem",
              padding: "8px 12px",
              backgroundColor: isSubmitted ? "rgba(255, 255, 255, 0.02)" : "rgba(255, 255, 255, 0.06)"
            }}
          />
        </div>
      ))}
      <Button
        type="submit"
        variant={formType === "rpa" ? "accent" : "primary"}
        size="sm"
        disabled={isSubmitted}
        fullWidth
        style={{
          fontSize: "0.8rem",
          fontWeight: "600",
          letterSpacing: "0.03em"
        }}
      >
        {isSubmitted ? "Enviando..." : "Enviar Formulario"}
      </Button>
    </form>
  );
};

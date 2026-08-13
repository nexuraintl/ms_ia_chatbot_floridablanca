import { useChat } from "../../context/ChatContext";
import { IdentityCard } from "./IdentityCard";

/**
 * Conecta `IdentityCard` al contexto del chat.
 *
 * `IdentityCard` se mantiene puramente presentacional —recibe todo por props y no
 * conoce el contexto— para poder renderizarla en pruebas o en un catálogo de
 * componentes sin montar el proveedor completo. Este envoltorio es el único que sabe
 * de dónde salen los datos, igual que hacen `PqrsdCreateCard` y `PqrsdConsultCard`.
 */
export const IdentityCardConnected = () => {
  const { identitySettings, isIdentitySkippable, submitIdentity, skipIdentity, isLoading } = useChat();

  return (
    <IdentityCard
      title={identitySettings?.title}
      subtitle={identitySettings?.subtitle}
      consentText={identitySettings?.consentText}
      policyUrl={identitySettings?.policyUrl}
      isSkippable={isIdentitySkippable}
      isSubmitting={isLoading}
      onSubmit={submitIdentity}
      onSkip={skipIdentity}
    />
  );
};

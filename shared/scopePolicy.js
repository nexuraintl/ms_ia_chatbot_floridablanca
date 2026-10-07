import { normalize } from './conversationContext.js';
export const scopeVerdict = (text) => {
  const q = normalize(text);
  // Una competencia local puede compartir vocabulario con trivia (perros, deportes).
  const localService = /esteriliz|zoonosis|vacun|denunci|adopci|maltrato|sisben|predial|industria y comercio|\bica\b|calendario tributario|escenario deportivo|programa.*deport/.test(q);
  const alien = /perro mas|gato mas|mas\s+\w+\s+del mundo|\b(netflix|anime|minecraft|horoscopo|tarot|bitcoin|trading)\b|haz mi tarea|\b(traduce|traduceme)\b|receta de|codigo (python|javascript)|partido de anoche|capital de (?!santander)/.test(q);
  return { allowed: localService || !alien, reason: localService ? 'municipal_term' : alien ? 'off_topic_term' : 'no_off_topic_signal' };
};

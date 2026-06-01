import express, { Request, Response, NextFunction } from "express";
import axios from "axios";
import { load } from "cheerio";
import cors from "cors";
import nodemailer from "nodemailer";
import { GoogleGenAI } from "@google/genai";
import Groq from "groq-sdk";
import "dotenv/config";
import https from "https";

const app = express();
app.use(cors());
app.use(express.json());

// --- GEMINI AI CONFIG ---
let aiInstance: GoogleGenAI | null = null;
let lastApiKeyUsed: string | undefined = undefined;

function getGeminiClient(): GoogleGenAI | null {
  const currentKey = process.env.GEMINI_API_KEY;
  if (!currentKey) {
    aiInstance = null;
    lastApiKeyUsed = undefined;
    return null;
  }
  
  if (!aiInstance || lastApiKeyUsed !== currentKey) {
    aiInstance = new GoogleGenAI({
      apiKey: currentKey,
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build',
        }
      }
    });
    lastApiKeyUsed = currentKey;
    console.log("✅ Gemini AI Engine initialized/updated with key from environment.");
  }
  
  return aiInstance;
}

// --- GROQ AI CONFIG ---
let groqInstance: Groq | null = null;
function getGroqClient(): Groq | null {
  const currentKey = process.env.GROQ_API_KEY;
  if (!currentKey) return null;
  if (!groqInstance) {
    groqInstance = new Groq({ apiKey: currentKey });
    console.log("✅ Groq AI Engine initialized with key from environment.");
  }
  return groqInstance;
}

// --- MAILING LOGIC (Merged to prevent Vercel import issues) ---
const port = parseInt(process.env.SMTP_PORT || "587");
const isSecure = process.env.SMTP_SECURE === "true" || port === 465;

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || "smtp.gmail.com",
  port,
  secure: isSecure,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
  tls: { rejectUnauthorized: false }
});

async function internalSendEmail({ to, subject, text, html }: { to: string; subject: string; text?: string; html?: string }) {
  if (!process.env.SMTP_USER || !process.env.SMTP_PASS) {
    throw new Error("SMTP credentials missing");
  }
  return await transporter.sendMail({
    from: process.env.SMTP_USER,
    to,
    subject,
    text,
    html,
  });
}

// --- DETERMINISTIC ANALYSIS ENGINE (SLM) ---
function roughScrapAnalysis(text: string, title: string, metaDescription: string): { knowledgeBase: string, missingTips: string[], businessName: string } {
  const safeText = (text || '').replace(/\s\s+/g, ' ').trim();
  
  // Extract patterns efficiently
  const emails = Array.from(safeText.matchAll(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g)).map(m => m[0]);
  const uniqueEmails = [...new Set(emails)];
  const phones = Array.from(safeText.matchAll(/(\+?\d{1,3}[-.\s]?)?\(?\d{2,5}\)?[-.\s]?\d{3,4}[-.\s]?\d{3,5}/g)).map(m => m[0]);
  const uniquePhones = [...new Set(phones)].filter(p => p.length >= 10);

  const pricingMatches = Array.from(safeText.matchAll(/(\$|₹|USD|INR|Rs\.?)\s?\d+(?:\.\d{2})?/gi)).map(m => m[0]);
  const uniquePrices = [...new Set(pricingMatches)].slice(0, 15);

  const sections = safeText.split('\n').filter(l => l.trim().length > 10);
  const coreContent = sections.filter(l => {
    const low = l.toLowerCase();
    return low.includes('service') || low.includes('product') || low.includes('price') || 
           low.includes('offer') || low.includes('about') || low.includes('contact') ||
           low.includes('policy');
  }).slice(0, 40);

  const kb = `
--- BUSINESS KNOWLEDGE BASE ---
BUSINESS: ${title || 'Business'}
ABOUT: ${metaDescription || 'Information provided via manual entry or website scan.'}

KEY DETAILS & SERVICES:
${coreContent.join('\n') || 'Refer to the raw data below for full details.'}

PRICING & OFFERS:
${uniquePrices.join(', ') || 'Inquire for pricing details.'}

CONTACT INFO:
- Emails: ${uniqueEmails.join(', ')}
- Phone: ${uniquePhones.join(', ')}

ADDITIONAL RAW CONTENT:
${safeText.substring(0, 10000)}
  `.trim();

  return {
    knowledgeBase: kb,
    missingTips: uniquePrices.length === 0 ? ["Add specific pricing details"] : [],
    businessName: title || ""
  };
}

function roughScrapChat(
  query: string,
  knowledgeBase: string,
  personality: string,
  customInstructions: string = '',
  primaryLanguage: string = 'auto',
  chatHistory: any[] = [],
  greetingMessage: string = ''
) {
  const lowQuery = query.toLowerCase().trim();
  
  // Hinglish / Hindi detection
  const isHindi = lowQuery.includes('kaise') || lowQuery.includes('kya') || lowQuery.includes('hai') || lowQuery.includes('batao') || lowQuery.includes('namaste') || lowQuery.includes('karo') || lowQuery.includes('sakte') || lowQuery.includes('bhai') || lowQuery.includes('yaar') || lowQuery.includes('kuch') || lowQuery.includes('hoga') || lowQuery.includes('shi') || lowQuery.includes('sahi') || lowQuery.includes('naam') || lowQuery.includes('kaam') || lowQuery.includes('paise') || lowQuery.includes('rupay') || lowQuery.includes('milega') || lowQuery.includes('kaha') || lowQuery.includes('tumhara');

  // Parse sections and lines of Knowledge Base
  const cleanKB = (knowledgeBase || '').trim();
  const rawLines = cleanKB.split('\n').map(l => l.trim()).filter(l => l.length > 5);
  
  // Clean text helper to strip technical tags
  const cleanResponseBlock = (text: string) => {
    return text
      .replace(/^BUSINESS:\s*/gi, '')
      .replace(/^ABOUT:\s*/gi, '')
      .replace(/^KEY DETAILS & SERVICES:\s*/gi, '')
      .replace(/^PRICING & OFFERS:\s*/gi, '')
      .replace(/^CONTACT INFO:\s*/gi, '')
      .replace(/^---\s*BUSINESS KNOWLEDGE BASE\s*---/gi, '')
      .replace(/^ADDITIONAL RAW CONTENT:\s*/gi, '')
      .trim();
  };

  // Helper to extract clean emails, phone numbers and addresses
  const emails: string[] = [];
  const phones: string[] = [];
  let location = "";

  rawLines.forEach(line => {
    const lowLine = line.toLowerCase();
    const emailMatch = line.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g);
    if (emailMatch) emailMatch.forEach(e => emails.push(e));

    const phoneMatch = line.match(/(\+?\d{1,3}[-.\s]?)?\(?\d{2,5}\)?[-.\s]?\d{3,4}[-.\s]?\d{3,5}/g);
    if (phoneMatch) phoneMatch.forEach(p => { if (p.length >= 10) phones.push(p); });

    if (lowLine.includes('address:') || lowLine.includes('location:') || lowLine.includes('pata:') || lowLine.includes('office:')) {
      location = cleanResponseBlock(line);
    }
  });

  const uniqueEmails = [...new Set(emails)];
  const uniquePhones = [...new Set(phones)];

  // Helper to extract services lines
  const serviceLines = rawLines
    .filter(l => {
      const low = l.toLowerCase();
      return (low.includes('service') || low.includes('product') || low.includes('feature') || low.includes('offer') || low.includes('automate') || low.includes('specialty') || low.includes('provide') || low.includes('kaam')) &&
             !low.includes('contact') && !low.includes('email') && !low.includes('phone') && !low.includes('---');
    })
    .map(cleanResponseBlock);

  // Helper to extract pricing lines
  const pricingLines = rawLines
    .filter(l => {
      const low = l.toLowerCase();
      return (low.includes('price') || low.includes('pricing') || low.includes('cost') || low.includes('charge') || low.includes('rate') || low.includes('offer') || low.includes('₹') || low.includes('$') || low.includes('rs.')) &&
             !low.includes('contact') && !low.includes('---');
    })
    .map(cleanResponseBlock);

  // Helper to extract policy lines
  const policyLines = rawLines
    .filter(l => {
      const low = l.toLowerCase();
      return low.includes('refund') || low.includes('policy') || low.includes('guarantee') || low.includes('cancel') || low.includes('return');
    })
    .map(cleanResponseBlock);

  // 1. GREETING INTENT
  const greetings = ['hi', 'hello', 'hey', 'hello hi', 'greeting', 'greetings', 'hola', 'hi there', 'namaste', 'heyy', 'yo', 'sup', 'salam', 'kaise ho', 'how are you'];
  const matchesGreeting = greetings.some(g => lowQuery.includes(g)) || lowQuery.length < 3;

  if (matchesGreeting) {
    if (greetingMessage) return greetingMessage;
    if (isHindi) {
      return `Namaste! Kaise hain aap? main aapka digital business representative assistant hoon. 😊✨\n\nAap humari services, rates, offers, ya direct contact details ke baare mein kuch bhi pooch sakte hain. Main aapki madad karne ke liye bilkul taiyar hoon! Aaj kya help chahiye?`;
    }
    return `Hello there! 👋 Warm welcome to our business chat window! I am your dedicated virtual representative assistant here. 😊\n\nHow can I help you support your business today? Please feel free to ask me anything about our key services, pricing guides, or direct contact methods!`;
  }

  // 2. IDENTITY / WHO ARE YOU INTENT
  if (lowQuery.includes('who are you') || lowQuery.includes('tum kaun') || lowQuery.includes('aap kaun') || lowQuery.includes('identify') || lowQuery.includes('name') || lowQuery.includes('naam') || lowQuery.includes('your bot') || lowQuery.includes('what is this app')) {
    if (isHindi) {
      return `Main aapka premium digital business representative assistant bot hoon. 🤖✨\n\nMain humari services aur customer care guidelines se fully trained hoon jisse main aapse perfect natural aur real-time baatein kar saku! Aap jo bhi details jaanna chahte hain kripya batayein!`;
    }
    return `I am your business's custom smart digital chatbot support assistant! 🤖✨\n\nI have been specialized to handle customer queries, share service outlines, pricing details, and answer any general questions seamlessly in real time! How may I assist you now?`;
  }

  // 3. CONTACT / LOCATION INTENT
  if (lowQuery.includes('contact') || lowQuery.includes('phone') || lowQuery.includes('email') || lowQuery.includes('reach') || lowQuery.includes('number') || lowQuery.includes('address') || lowQuery.includes('pata') || lowQuery.includes('location') || lowQuery.includes('office') || lowQuery.includes('kaha hai') || lowQuery.includes('milna')) {
    const lines = [];
    if (uniquePhones.length > 0) lines.push(`📞 Phone: ${uniquePhones.join(', ')}`);
    if (uniqueEmails.length > 0) lines.push(`📧 Email: ${uniqueEmails.join(', ')}`);
    if (location) lines.push(`📍 Office: ${location}`);
    
    if (lines.length > 0) {
      if (isHindi) {
        return `Haanji bilkul! Aap humse niche diye gaye contact options ke jariye kabhi bhi connect kar sakte hain:\n\n${lines.join('\n')}\n\nHumari team aapse connect karne aur aapke doubts door karne ke liye hamesha active hai! Kripya batayein kya main kuch aur batayein? 📞😊`;
      }
      return `We would absolutely love to stay connected with you! Here is our official contact directory to reach out directly:\n\n${lines.join('\n')}\n\nPlease reach out to our team at any time! We are highly active and excited to answer your questions! ✨📞`;
    } else {
      // Look in backup lines
      const foundContact = rawLines.filter(l => l.includes('@') || l.match(/\d{9,12}/) || l.toLowerCase().includes('location') || l.toLowerCase().includes('address')).map(cleanResponseBlock);
      if (foundContact.length > 0) {
        if (isHindi) {
          return `Aap humse connect kar sakte hain! Yahan humari saari contact details hain:\n\n${foundContact.slice(0, 3).join('\n')}\n\nAap jab chahein humse contact kar sakte hain! 😊`;
        }
        return `We'd love to stay connected! Here is our contact information:\n\n${foundContact.slice(0, 3).join('\n')}\n\nPlease reach out anytime! 🌟`;
      }
    }
  }

  // 4. SERVICES INTENT
  if (lowQuery.includes('service') || lowQuery.includes('product') || lowQuery.includes('kaam') || lowQuery.includes('work') || lowQuery.includes('features') || lowQuery.includes('what do') || lowQuery.includes('kis liye') || lowQuery.includes('kya karte') || lowQuery.includes('offers')) {
    if (serviceLines.length > 0) {
      const bullets = serviceLines.slice(0, 5).map(l => `• ${l}`).join('\n');
      if (isHindi) {
        return `Hamare business doorsteps par aapko ye premium services aur solutions diye jaate hain:\n\n${bullets}\n\nAap inme se kisi bhi offering ke baare mein specifically kuch bhi pooch sakte hain. Main detailed guide provide kar dunga! 😊📊`;
      }
      return `We are extremely thrilled to display our professional services and product lines with you! Here is our key offerings list:\n\n${bullets}\n\nPlease let me know if you would like me to unpack or discuss any of these specific areas further! 📊😊`;
    }
  }

  // 5. PRICING INTENT
  if (lowQuery.includes('price') || lowQuery.includes('pricing') || lowQuery.includes('cost') || lowQuery.includes('charge') || lowQuery.includes('rate') || lowQuery.includes('rupay') || lowQuery.includes('paise') || lowQuery.includes('budget') || lowQuery.includes('free') || lowQuery.includes('kitne ka')) {
    if (pricingLines.length > 0) {
      const bullets = pricingLines.slice(0, 5).map(l => `• ${l}`).join('\n');
      if (isHindi) {
        return `Bilkul! Hamare pricing plans aur amazing deals ke details ye rahe:\n\n${bullets}\n\nHamari pricing hamesha transparent aur pocket-friendly rehti h. Iske alawa koi aur sawal hai? 💰😊`;
      }
      return `Certainly! Here is an overview of our pricing details, rate cards, and customized offers:\n\n${bullets}\n\nWe love providing competitive and highly cost-effective solutions. Let me know if you want to request a quote! 💰✨`;
    }
  }

  // 6. REFUND / POLICIES INTENT
  if (lowQuery.includes('refund') || lowQuery.includes('refund policy') || lowQuery.includes('return') || lowQuery.includes('policy') || lowQuery.includes('guarantee') || lowQuery.includes('cancel')) {
    if (policyLines.length > 0) {
      const bullets = policyLines.slice(0, 3).map(l => `• ${l}`).join('\n');
      if (isHindi) {
        return `Hamari consumer refund aur trust policies ke rules ye hain:\n\n${bullets}\n\nHum hamesha fairness aur consumer satisfaction guarantees par works karte hain! 👍`;
      }
      return `We deeply prioritize transparency and client trust. Here is the outline of our official refund and cancelation policies:\n\n${bullets}\n\nOur client agreements protect our buyers at all times. Please ask if you need further explanation! 📝`;
    }
  }

  // 7. MULTI-KEYWORD SEMANTIC MATCH (General Q&A Fallback)
  // Tokenize query to find search keywords, removing common stop words
  const stopWords = new Set([
    'what', 'is', 'the', 'are', 'do', 'you', 'about', 'for', 'please', 'can', 'tell', 'me', 'how', 'any', 'some', 'there', 'who', 'where', 'when', 'why', 'which', 'whom', 'whose', 'this', 'that', 'these', 'those', 'a', 'an', 'at', 'by', 'of', 'on', 'with', 'to', 'from', 'in', 'out', 'up', 'down', 'and', 'or', 'but',
    'kya', 'hai', 'kaise', 'batao', 'karo', 'sakte', 'bhai', 'yaar', 'aap', 'ka', 'ki', 'ke', 'ko', 'se', 'tha', 'thi', 'the', 'hai', 'hain', 'mein', 'par', 'aur', 'ya', 'lekin', 'mujhe', 'kuch', 'ek'
  ]);
  const rawWords = lowQuery.replace(/[.,\/#!$%\^&\*;:{}=\-_`~()?\n]/g, " ").split(/\s+/);
  const queryKeywords = rawWords.filter(word => word.length > 2 && !stopWords.has(word));

  const sections = cleanKB.split(/\n\n+/).map(s => s.trim()).filter(s => s.length > 5);
  const candidates = Array.from(new Set([...sections, ...rawLines]));
  const scoredCandidates: {text: string, score: number}[] = [];

  for (const candidate of candidates) {
    const lowCand = candidate.toLowerCase();
    if (lowCand.includes('--- business knowledge base ---') || lowCand.includes('additional raw content:') || lowCand.includes('--- source:')) {
      continue;
    }

    let score = 0;
    for (const keyword of queryKeywords) {
      if (lowCand.includes(keyword)) {
        score += 3;
        const regex = new RegExp(`\\b${keyword}\\b`, 'i');
        if (regex.test(lowCand)) {
          score += 2;
        }
      }
    }

    if (queryKeywords.length > 1) {
      const phrase = queryKeywords.slice(0, 3).join(' ');
      if (lowCand.includes(phrase)) score += 5;
    }

    if (score > 0) {
      scoredCandidates.push({ text: candidate, score });
    }
  }

  scoredCandidates.sort((a, b) => b.score - a.score);

  if (scoredCandidates.length > 0 && scoredCandidates[0].score >= 3) {
    const bestMatch = cleanResponseBlock(scoredCandidates[0].text);
    let answerText = bestMatch;

    if (scoredCandidates.length > 1 && scoredCandidates[1].score >= scoredCandidates[0].score * 0.7) {
      const secondMatch = cleanResponseBlock(scoredCandidates[1].text);
      if (secondMatch !== bestMatch && !bestMatch.includes(secondMatch)) {
        answerText += '\n\n' + secondMatch;
      }
    }

    // Return direct answer format as requested (no artificial prefixes/suffixes)
    return answerText.trim();
  }

  // 8. FINAL CLEVER SUGGESTIVE FALLBACK (Sound very smart!)
  const visibleServices = serviceLines.slice(0, 2).join(', ');
  const contactHint = uniquePhones.length > 0 ? `Phone (${uniquePhones[0]})` : '';

  if (isHindi) {
    let fallbackMsg = "Mujhe aapke is specific query ke baare mein exact detail nahi mili, par main aapse connect karwa sakta hoon! 🤖\n\n";
    if (visibleServices) {
      fallbackMsg += `Hum basically in services me deal karte hain: ${visibleServices}. Inpar koi sawal h aapka?\n\n`;
    }
    if (contactHint) {
      fallbackMsg += `Ya aap humari team se direct contact kar sakte hain humare is details par: ${contactHint}.\n\n`;
    }
    fallbackMsg += "Aap kripya humari services, pricing list ya contact options ke baare mein kuch bhi poochiye! Main jawab dene ke liye active hoon. 😊✨";
    return fallbackMsg;
  } else {
    let fallbackMsg = "I couldn't locate that exact answer in my verified files, but I'm here to search more or guide you closely! 🤖\n\n";
    if (visibleServices) {
      fallbackMsg += `We primarily focus and specialize in: ${visibleServices}.\n\n`;
    }
    if (contactHint) {
      fallbackMsg += `Or you can reach our team directly at: ${contactHint}.\n\n`;
    }
    fallbackMsg += "Please feel free to ask me questions specifically about our main services, pricing schedules, or help options! I am ready to assist you! 😊👍";
    return fallbackMsg;
  }
}

// --- GEMINI AI ENGINE ---
async function geminiChat(query: string, knowledgeBase: string, personality: string, customInstructions: string = '', primaryLanguage: string = 'auto', chatHistory: any[] = [], greetingMessage: string = '') {
  // Simple cleanup of knowledge base to remove noise
  const cleanKB = (knowledgeBase || '')
    .substring(0, 15000)
    .trim();

  const hasKnowledge = cleanKB.length > 20;

  const systemPrompt = `You are a highly helpful, smart, warm, and natural conversational AI assistant (like ChatGPT/Gemini) representing the business.
You got some custom knowledge base records ("OFFICIAL BUSINESS RECORDS / WEBSITE WIKI") which is your supreme source of truth for business-specific details.

CRITICAL CONVERSATIONAL DIRECTIVES:
1. ALWAYS act like a highly intellectual, helpful AI companion with absolute conversational freedom.
2. PRIORITIZE the facts, details, services, pricing, guidelines, and contact information from the OFFICIAL BUSINESS RECORDS to answer any business-specific queries. 
3. If a query is about the business, rely strictly on these records. Do not invent fake prices or fake contact info.
4. If a query is general in nature (greetings, helpful questions, standard conversation, or general queries), answer beautifully, warmly, and smartly. Genuinely try to bring the conversation back to the business's services and details in a helpful, conversational manner. Never respond with static, robotic denials.
5. NO SURROUNDING METADATA OR LABELS (STRICT): Do NOT add any surrounding prefixes or suffixes like "Based on the records:", "Source:", "Verified Sources:", "According to our documents:", "As an AI, I found:", or intro/outro comments about how you found the information. Answer DIRECTLY, naturally, and conversationally.
6. LANGUAGE COMPLIANCE: Mirror the user's language and tone perfectly. If they use a mix of Hindi & English (Hinglish) or everyday Hindi, respond warmly and with natural flow in the same Hinglish/colloquial style, using natural local expressions (like "Ji bilkul", "Haanji", "Aapne bilkul sahi kaha").
7. VOICE & IDENTITY: Speak in first-person plural: "We", "Us", "Our", "Hum", "Humare". Speak with absolute premium warmth and human-like empathy.
8. NO DIRECT COPY-PASTING VERBATIM: Never copy and paste multiple lines or entire blocks of raw documentation words into the response. Summarize and rephrase the details elegantly in your own words so that it sounds polished, completely interactive, human, and conversational, rather than sounding like a raw file search results dump.
9. MULTI-TURN DIALOGUE: Answer the questions intelligently by referencing the actual ongoing dialogue context, and maintain a highly pleasing, logical flow. Feel free to ask nice, relevant, open-ended questions like a friendly support representative.

OFFICIAL BUSINESS RECORDS:
${hasKnowledge ? cleanKB : 'No specific custom business details are uploaded yet. Be a super warm, friendly representative of our modern startup platform called Botub. Answer general support, greetings, and generic questions beautifully and intellectually while representing us gracefully.'}

BRAND RULES & COMMUNICATIONS:
- TONE: ${personality}
- VOICE: Natural, engaging, supportive and 100% human-like. Never mention technical words like "records", "knowledge base", "database", "system", "retrieved", or "AI model". Speak as a live team representative.
- GREETINGS: Respond with delight and absolute sweetness to greetings like "Hi", "Hello", "Namaste". ${greetingMessage ? `Answer greetings naturally first, and you can also incorporate or say: "${greetingMessage}"` : 'Be spontaneous.'}
- UNKNOWN DEFIANCE: If they ask for specific private business details (like pricing, refund, address) that are completely absent from OFFICIAL BUSINESS RECORDS, apologize with absolute empathy and explain we don't have that specific record set up yet, but immediately try to cross-sell our main services and provide contact info if available in records.
- CUSTOM BRAIN INSTRUCTION: ${customInstructions || 'None'}`;

  // Build conversational turns natively for Gemini
  const rawContents: any[] = [];
  if (chatHistory && chatHistory.length > 0) {
    chatHistory.slice(-10).forEach(m => {
      const role = (m.role === 'user' || m.role === 'customer') ? 'user' : 'model';
      const text = m.content || m.text || '';
      if (text.trim()) {
        rawContents.push({
          role,
          parts: [{ text: text.trim() }]
        });
      }
    });
  }

  // Ensure last / current query is appended
  rawContents.push({
    role: 'user',
    parts: [{ text: query.trim() }]
  });

  // Clean and alternate turns perfectly (merging consecutive identical turns)
  const contents: any[] = [];
  rawContents.forEach((turn) => {
    if (contents.length === 0) {
      if (turn.role === 'user') {
        contents.push(turn);
      }
    } else {
      const lastTurn = contents[contents.length - 1];
      if (lastTurn.role === turn.role) {
        // Merge identical consecutive roles into a single turn
        lastTurn.parts[0].text += "\n" + turn.parts[0].text;
      } else {
        contents.push(turn);
      }
    }
  });

  // Try Gemini 3.5 Flash first
  const client = getGeminiClient();
  if (client) {
    try {
      console.log("🤖 Attempting chat completion with Gemini 3.5 Flash using structured turns...");
      const response = await client.models.generateContent({
        model: "gemini-3.5-flash",
        contents,
        config: {
          systemInstruction: systemPrompt,
          temperature: 0.85,
          topP: 0.95,
          maxOutputTokens: 1000
        }
      });

      let text = response.text;
      if (text && text.length >= 2) {
        return text;
      }
      throw new Error("Empty Gemini response");
    } catch (err: any) {
      console.warn("⚠️ Gemini 3.5 Flash failed, trying fallback model gemini-2.5-flash. Error details:", err.message || err);
      
      try {
        console.log("🤖 Attempting chat completion with gemini-2.5-flash fallback...");
        const response2 = await client.models.generateContent({
          model: "gemini-2.5-flash",
          contents,
          config: {
            systemInstruction: systemPrompt,
            temperature: 0.85,
            topP: 0.95,
            maxOutputTokens: 1000
          }
        });

        let text2 = response2.text;
        if (text2 && text2.length >= 2) {
          console.log("✅ Successfully generated response using gemini-2.5-flash!");
          return text2;
        }
        throw new Error("Empty gemini-2.5-flash response");
      } catch (err2: any) {
        console.warn("⚠️ gemini-2.5-flash fallback failed. Error details:", err2.message || err2);
      }
    }
  }

  // Dual Fallback: Try Groq Client (Llama 3.3)
  const groq = getGroqClient();
  if (groq) {
    try {
      console.log("🚀 Attempting fallback chat completion with Groq (Llama-3.3-70b)...");
      const messages: any[] = [
        { role: "system", content: systemPrompt }
      ];
      chatHistory.slice(-6).forEach(m => {
        messages.push({
          role: m.role === 'user' ? 'user' : 'assistant',
          content: m.content || m.text || ""
        });
      });
      messages.push({ role: "user", content: query });

      const response = await groq.chat.completions.create({
        model: "llama-3.3-70b-versatile",
        messages,
        temperature: 0.85,
        max_tokens: 1000,
      });

      const text = response.choices[0]?.message?.content;
      if (text && text.length >= 2) {
        console.log("✅ Successfully generated response using Groq!");
        return text;
      }
      throw new Error("Empty Groq response");
    } catch (err: any) {
      console.warn("⚠️ Groq fallback chat completion failed. Error details:", err.message || err);
    }
  }

  // Backup Retry: try Gemini dev model (gemini-3.1-flash-lite)
  if (client) {
    try {
      console.log("🤖 Attempting last-resort with gemini-3.1-flash-lite...");
      const retryResponse = await client.models.generateContent({
        model: "gemini-3.1-flash-lite",
        contents,
        config: {
          systemInstruction: systemPrompt,
          temperature: 0.82,
          topP: 0.92,
          maxOutputTokens: 1000
        }
      });

      let retryText = retryResponse.text;
      if (retryText && retryText.length >= 2) {
        console.log("✅ Successfully recovered using gemini-3.1-flash-lite!");
        return retryText;
      }
    } catch (retryErr: any) {
      console.error("❌ gemini-3.1-flash-lite fallback failed:", retryErr.message || retryErr);
    }
  }

  // Ultimate deterministic fallback
  console.log("💡 Reverting to local natural engine fallback.");
  return roughScrapChat(query, cleanKB, personality, customInstructions, primaryLanguage, chatHistory, greetingMessage);
}

async function geminiAnalyze(text: string, title: string, description: string) {
  const fallback = roughScrapAnalysis(text, title, description);
  const client = getGeminiClient();
  if (!client || !text) return fallback;
  
  const promptText = `You are an Expert Business Consultant and Data Architect. Analyze the raw text and structure it into a perfect Knowledge Base.

TASK:
1. Extract Company Name, Essential Services, Pricing, Contact Numbers, WhatsApp, Email, Refund Policy, and FAQs.
2. IMPORTANT: If any of these are MISSING from the text, you MUST list them as specific, actionable tips in "missingTips".
3. Each Tip should be short, like: "WhatsApp number missing", "Pricing for service X is unclear", "Refund policy not found".

OUTPUT JSON FORMAT ONLY:
{
  "knowledgeBase": "Markdown text...",
  "missingTips": ["Tip 1", "Tip 2"],
  "businessName": "Company Name"
}

SOURCE DATA: ${title}
RAW CONTENT: 
${text.substring(0, 10000)}`;

  // Try gemini-3.5-flash
  try {
    const response = await client.models.generateContent({ 
      model: "gemini-3.5-flash",
      contents: promptText,
      config: { maxOutputTokens: 2000 }
    });
    
    let rText = response.text || "";
    if (rText && rText.length >= 5) {
      const jsonM = rText.match(/\{[\s\S]*\}/);
      if (jsonM) {
        try {
          const parsed = JSON.parse(jsonM[0]);
          if (parsed.knowledgeBase) return parsed;
        } catch (e) {}
      }
    }
    throw new Error("Failed to get parsed json from 3.5 model");
  } catch (err: any) {
    console.warn("⚠️ Fallback Retry: geminiAnalyze on gemini-3.5-flash failed, retrying on gemini-2.5-flash:", err.message || err);
    
    // Retrying with gemini-2.5-flash
    try {
      const response = await client.models.generateContent({ 
        model: "gemini-2.5-flash",
        contents: promptText,
        config: { maxOutputTokens: 2000 }
      });
      
      let rText = response.text || "";
      if (rText && rText.length >= 5) {
        const jsonM = rText.match(/\{[\s\S]*\}/);
        if (jsonM) {
          const parsed = JSON.parse(jsonM[0]);
          if (parsed.knowledgeBase) {
            console.log("✅ Successfully generated analysis using gemini-2.5-flash!");
            return parsed;
          }
        }
      }
      return fallback;
    } catch (retryErr: any) {
      console.error("❌ Both Gemini analyze tries failed. Returning SLM fallback:", retryErr.message || retryErr);
      return fallback;
    }
  }
}

// --- API ROUTES ---

const apiRouter = express.Router();

apiRouter.get("/health", (req, res) => {
  const client = getGeminiClient();
  res.json({ 
    status: "ok", 
    engine: client ? "Gemini 3 Flash Preview" : "Deterministic SLM",
    ai_ready: !!client
  });
});

apiRouter.post("/send-report", async (req, res) => {
  const { email, reportContent, subject } = req.body;
  if (!email || !reportContent) return res.status(400).json({ error: "Missing fields" });
  try {
    await internalSendEmail({ to: email, subject: subject || "Botub Analysis", text: reportContent });
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: "Email Error" });
  }
});

apiRouter.post("/analyze-website", async (req, res) => {
  let { url } = req.body;
  if (!url) return res.status(400).json({ error: "URL is required" });
  if (!url.startsWith('http')) url = 'https://' + url;

  console.log(`Cheerio Analysis for: ${url}`);

  try {
    const agent = new https.Agent({ rejectUnauthorized: false });
    const response = await axios.get(url, {
      headers: { 
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Cache-Control': 'no-cache'
      },
      timeout: 15000,
      httpsAgent: agent,
      validateStatus: () => true
    });

    if (response.status >= 400 || !response.data) {
       return res.status(response.status || 500).json({ 
         error: "Access Restriction", 
         suggestion: "This site is protected. Please manually paste its text below." 
       });
    }

    const html = response.data;
    const $ = load(html);
    
    // Primary Cheerio Text Extraction
    $(`script, style, noscript, iframe, footer, nav, aside, svg, .cookie-banner, .ads`).remove();
    
    const title = $('title').text() || $('meta[property="og:title"]').attr('content') || 'Website';
    const description = $('meta[name="description"]').attr('content') || '';
    
    let extractedText = "";
    $('h1, h2, h3, p, li').each((_, el) => {
      const text = $(el).text().trim();
      if (text.length > 10) extractedText += `${text}\n`;
    });

    if (extractedText.length < 200) {
      extractedText = $('body').text().replace(/\s\s+/g, ' ').substring(0, 5000);
    }

    if (extractedText.length < 50) {
      return res.status(422).json({ error: "Empty Content", suggestion: "Scanner couldn't read the page. Manual input needed." });
    }

    console.log(`Extracted ${extractedText.length} characters with Cheerio.`);
    const result = await geminiAnalyze(extractedText, title, description);
    res.json({ result, title, crawledCount: 1 });
  } catch (err: any) {
    console.error("Scanner Error:", err);
    res.status(500).json({ error: "Scanner encountered a critical failure. Please paste info manually." });
  }
});

apiRouter.post("/analyze-text", async (req, res) => {
  const { text, title } = req.body;
  if (!text) return res.status(400).json({ error: "Text is required" });
  try {
    const result = await geminiAnalyze(text, title || "Manual Entry", "User provided business details");
    res.json({ result });
  } catch (err) {
    res.status(500).json({ error: "Analysis failed" });
  }
});

apiRouter.post("/chat", async (req, res) => {
  const { prompt, knowledgeBase, personality, customInstructions, primaryLanguage, chatHistory, greetingMessage, botName, ownerEmail } = req.body;
  try {
    const text = await geminiChat(
      prompt || '', 
      knowledgeBase || '', 
      personality || 'professional', 
      customInstructions || '', 
      primaryLanguage || 'auto',
      chatHistory || [],
      greetingMessage || ''
    );

    // LEAD CAPTURE DETECTION & REAL-TIME EMAIL ALERT
    try {
      const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/gi;
      const phoneRegex = /(?:\+?\d{1,3}[-.\s]?)?\(?\d{2,5}\)?[-.\s]?\d{3,4}[-.\s]?\d{3,10}/gi;
      
      const emailMatches = prompt?.match(emailRegex);
      const phoneMatches = prompt?.match(phoneRegex);
      const validPhones = phoneMatches ? phoneMatches.filter(p => p.replace(/\D/g, '').length >= 8) : [];
      
      if (emailMatches || validPhones.length > 0) {
        console.log("🔥 Lead detected in user chat message! Starting email notification...");
        const recipient = ownerEmail || process.env.SMTP_USER;
        
        if (recipient && process.env.SMTP_USER && process.env.SMTP_PASS) {
          const contentHtml = `
            <div style="font-family: 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; padding: 30px; color: #1e293b; max-width: 600px; margin: 0 auto; border: 1px solid #e2e8f0; border-radius: 20px; background-color: #ffffff; box-shadow: 0 4px 12px rgba(0,0,0,0.03);">
              <div style="text-align: center; margin-bottom: 25px;">
                <span style="font-size: 40px;">🔥</span>
                <h2 style="color: #4f46e5; margin: 10px 0 5px 0; font-weight: 800; font-size: 24px;">New Lead Captured!</h2>
                <p style="color: #64748b; margin: 0; font-size: 14px;">Your Botub AI representative has gathered fresh contact information.</p>
              </div>
              
              <div style="background-color: #f8fafc; padding: 20px; border-radius: 16px; border: 1px solid #f1f5f9; margin-bottom: 25px;">
                <h3 style="margin: 0 0 15px 0; color: #0f172a; font-size: 16px; border-bottom: 1px solid #e2e8f0; padding-bottom: 8px;">Contact Information</h3>
                <table style="width: 100%; border-collapse: collapse;">
                  ${emailMatches ? `
                  <tr>
                    <td style="padding: 6px 0; font-weight: 600; color: #475569; width: 120px; font-size: 14px;">Email Address:</td>
                    <td style="padding: 6px 0; color: #0f172a; font-size: 14px;"><a href="mailto:${emailMatches[0]}" style="color: #4f46e5; text-decoration: none; font-weight: 600;">${emailMatches[0]}</a></td>
                  </tr>` : ''}
                  ${validPhones.length > 0 ? `
                  <tr>
                    <td style="padding: 6px 0; font-weight: 600; color: #475569; width: 120px; font-size: 14px;">Phone Number:</td>
                    <td style="padding: 6px 0; color: #0f172a; font-size: 14px;"><a href="tel:${validPhones[0]}" style="color: #4f46e5; text-decoration: none; font-weight: 600;">${validPhones[0]}</a></td>
                  </tr>` : ''}
                  <tr>
                    <td style="padding: 6px 0; font-weight: 600; color: #475569; width: 120px; font-size: 14px;">Chatbot Name:</td>
                    <td style="padding: 6px 0; color: #0f172a; font-size: 14px; font-weight: 500;">${botName || 'My Assistant'}</td>
                  </tr>
                </table>
              </div>
              
              <div style="border-left: 4px solid #cbd5e1; padding-left: 15px; margin: 20px 0; font-style: italic; color: #475569; font-size: 14px; line-height: 1.6;">
                <strong>User Message:</strong> "${prompt}"
              </div>
              
              <div style="text-align: center; margin-top: 30px; border-t: 1px solid #f1f5f9; padding-top: 20px;">
                <p style="font-size: 11px; color: #94a3b8; text-transform: uppercase; tracking-wider: 0.05em; margin: 0;">Powered by Botub Mailing System</p>
              </div>
            </div>
          `;

          await internalSendEmail({
            to: recipient,
            subject: `🔥 New Lead Captured by ${botName || 'your Chatbot'}!`,
            html: contentHtml
          });
          console.log("✅ Lead email sent successfully to", recipient);
        } else {
          console.warn("⚠️ SMTP Credentials missing, skipping lead email alert send.");
        }
      }
    } catch (mailErr: any) {
      console.error("⚠️ Background lead email notify failed:", mailErr.message || mailErr);
    }

    res.json({ text });
  } catch (err: any) {
    res.status(500).json({ error: "Execution Fail" });
  }
});

apiRouter.get("/config-status", (req, res) => {
  const client = getGeminiClient();
  const serverRuntime = process.env.VERCEL
    ? "Vercel Production"
    : process.env.DYNO
      ? "Heroku Dyno"
      : process.env.NODE_ENV === "production"
        ? "Node Production"
        : "Local Development";

  res.json({ 
    server: serverRuntime,
    db: !!process.env.FIREBASE_PROJECT_ID, 
    mail: !!process.env.SMTP_USER,
    ai: !!process.env.GEMINI_API_KEY,
    ai_initialized: !!client
  });
});

// Mount router on both /api and root to handle various Vercel/Local configurations
app.use("/api", apiRouter);
app.use("/", apiRouter);

app.use((err: any, req: Request, res: Response, next: NextFunction) => {
  console.error("Runtime Error:", err);
  res.status(500).json({ error: "Platform Runtime Error" });
});

export default app;

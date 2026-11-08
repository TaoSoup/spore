// Famous real people for root agents briefed in "people" mode (DESIGN §13.3; owner 2026-10-20:
// "the $HUMAN agent launches the world's people: Elon Musk → $ELON, Donald Trump → $TRUMP").
// The model names the people when it is available; this list is the fallback when it is not, or
// when every idea it gave was refused. Ordered by how widely known each person is around the world
// (roughly), across tech, politics, sport, music, film, science, history, business, crypto, the
// arts and the internet. Name = the full name the world knows; ticker = the name they go by.
//
// Never on the list, and refused in people mode whatever wrote the idea (PEOPLE_NEVER): people known
// mainly for atrocities, terrorism, serial violence or sexual crimes.
import { normalizeWord, wordsOf } from "./blocklist.mjs";

const LIST = `
Elon Musk|ELON|t
Donald Trump|TRUMP|p
Lionel Messi|MESSI|s
Cristiano Ronaldo|RONALDO|s
Taylor Swift|SWIFT|m
Jeff Bezos|BEZOS|b
Vitalik Buterin|VITALIK|x
Satoshi Nakamoto|SATOSHI|x
Albert Einstein|EINSTEIN|c
Mark Zuckerberg|ZUCK|t
Bill Gates|GATES|t
Steve Jobs|JOBS|t
Michael Jordan|JORDAN|s
LeBron James|LEBRON|s
Barack Obama|OBAMA|p
Michael Jackson|JACKSON|m
Elvis Presley|ELVIS|m
Beyoncé Knowles|BEYONCE|m
Robyn Rihanna Fenty|RIHANNA|m
Keanu Reeves|KEANU|f
Leonardo DiCaprio|LEO|f
Dwayne Johnson|ROCK|f
Tom Cruise|CRUISE|f
Isaac Newton|NEWTON|c
Leonardo da Vinci|DAVINCI|a
Muhammad Ali|ALI|s
Usain Bolt|BOLT|s
Kylian Mbappé|MBAPPE|s
Neymar Júnior|NEYMAR|s
Jimmy Donaldson|MRBEAST|i
Warren Buffett|BUFFETT|b
Jensen Huang|JENSEN|t
Sam Altman|ALTMAN|t
Changpeng Zhao|CZ|x
Michael Saylor|SAYLOR|x
Marshall Mathers|EMINEM|m
Aubrey Drake Graham|DRAKE|m
Snoop Dogg|SNOOP|m
Mike Tyson|TYSON|s
Abraham Lincoln|LINCOLN|h
Mahatma Gandhi|GANDHI|h
Nelson Mandela|MANDELA|h
Martin Luther King Jr.|MLK|h
Winston Churchill|CHURCHILL|h
Napoleon Bonaparte|NAPOLEON|h
Julius Caesar|CAESAR|h
Cleopatra|CLEOPATRA|h
John F. Kennedy|JFK|p
Joe Biden|BIDEN|p
Kamala Harris|KAMALA|p
Stephen Hawking|HAWKING|c
Marie Curie|CURIE|c
Charles Darwin|DARWIN|c
Galileo Galilei|GALILEO|c
Pablo Picasso|PICASSO|a
Vincent van Gogh|VANGOGH|a
William Shakespeare|BARD|a
Wolfgang Amadeus Mozart|MOZART|m
Ludwig van Beethoven|BEETHOVEN|m
Freddie Mercury|FREDDIE|m
John Lennon|LENNON|m
Bob Marley|MARLEY|m
Madonna Ciccone|MADONNA|m
Lady Gaga|GAGA|m
Justin Bieber|BIEBER|m
Ariana Grande|ARIANA|m
Ed Sheeran|SHEERAN|m
Shakira Mebarak|SHAKIRA|m
Adele Adkins|ADELE|m
Bruno Mars|BRUNO|m
Billie Eilish|BILLIE|m
Abel Tesfaye|WEEKND|m
Bad Bunny|BADBUNNY|m
Kendrick Lamar|KENDRICK|m
Shawn Carter|JAYZ|m
Travis Scott|TRAVIS|m
Dua Lipa|DUALIPA|m
Selena Gomez|SELENA|m
Kim Kardashian|KIM|f
Oprah Winfrey|OPRAH|f
Brad Pitt|PITT|f
Angelina Jolie|JOLIE|f
Johnny Depp|DEPP|f
Will Smith|WILLSMITH|f
Morgan Freeman|FREEMAN|f
Tom Hanks|HANKS|f
Robert Downey Jr.|RDJ|f
Scarlett Johansson|SCARJO|f
Jackie Chan|JACKIE|f
Bruce Lee|BRUCELEE|f
Arnold Schwarzenegger|ARNOLD|f
Sylvester Stallone|STALLONE|f
Charlie Chaplin|CHAPLIN|f
Marilyn Monroe|MARILYN|f
Rowan Atkinson|BEAN|f
Roger Federer|FEDERER|s
Rafael Nadal|NADAL|s
Novak Djokovic|DJOKOVIC|s
Serena Williams|SERENA|s
Tiger Woods|TIGER|s
Tom Brady|BRADY|s
Diego Maradona|MARADONA|s
Pelé|PELE|s
Zinedine Zidane|ZIDANE|s
Erling Haaland|HAALAND|s
Mohamed Salah|SALAH|s
Stephen Curry|CURRY|s
Shaquille O'Neal|SHAQ|s
Lewis Hamilton|HAMILTON|s
Max Verstappen|VERSTAPPEN|s
Ayrton Senna|SENNA|s
Michael Phelps|PHELPS|s
Simone Biles|BILES|s
David Beckham|BECKHAM|s
Ronaldinho Gaúcho|RONALDINHO|s
Lamine Yamal|YAMAL|s
Shohei Ohtani|OHTANI|s
Victor Wembanyama|WEMBY|s
Floyd Mayweather|MAYWEATHER|s
Khabib Nurmagomedov|KHABIB|s
Magnus Carlsen|MAGNUS|s
Larry Page|PAGE|t
Sergey Brin|BRIN|t
Steve Wozniak|WOZ|t
Tim Cook|COOK|t
Jack Dorsey|DORSEY|t
Linus Torvalds|LINUS|t
Alan Turing|TURING|c
Ada Lovelace|LOVELACE|c
Tim Berners-Lee|TIMBL|t
Sundar Pichai|PICHAI|t
Satya Nadella|NADELLA|t
Peter Thiel|THIEL|b
Pavel Durov|DUROV|t
Jack Ma|JACKMA|b
Masayoshi Son|MASA|b
Gabe Newell|GABEN|t
John Carmack|CARMACK|t
Hideo Kojima|KOJIMA|t
Shigeru Miyamoto|MIYAMOTO|t
Hayao Miyazaki|MIYAZAKI|f
Demis Hassabis|HASSABIS|c
Lisa Su|LISASU|t
Palmer Luckey|LUCKEY|t
Bernard Arnault|ARNAULT|b
Larry Ellison|ELLISON|b
Richard Branson|BRANSON|b
Mark Cuban|CUBAN|b
Charlie Munger|MUNGER|b
Ray Dalio|DALIO|b
Mukesh Ambani|AMBANI|b
Carlos Slim|SLIM|b
Kevin O'Leary|OLEARY|b
Cathie Wood|CATHIE|b
Phil Knight|KNIGHT|b
Anatoly Yakovenko|TOLY|x
Hal Finney|FINNEY|x
Nick Szabo|SZABO|x
Gavin Wood|GAVIN|x
Charles Hoskinson|HOSKINSON|x
Justin Sun|JUSTINSUN|x
Andre Cronje|CRONJE|x
Arthur Hayes|HAYES|x
Raoul Pal|RAOUL|x
Hayden Adams|HAYDEN|x
Brian Armstrong|BRIAN|x
Mert Mumtaz|MERT|x
George Washington|WASHINGTON|h
Thomas Jefferson|JEFFERSON|h
Benjamin Franklin|FRANKLIN|h
Theodore Roosevelt|TEDDY|h
Franklin D. Roosevelt|FDR|h
Ronald Reagan|REAGAN|p
Margaret Thatcher|THATCHER|p
Queen Elizabeth II|QUEEN|h
Alexander the Great|ALEXANDER|h
Marcus Aurelius|AURELIUS|h
Joan of Arc|JOAN|h
Simón Bolívar|BOLIVAR|h
Harriet Tubman|TUBMAN|h
Rosa Parks|ROSAPARKS|h
Frederick Douglass|DOUGLASS|h
Malcolm X|MALCOLMX|h
Mikhail Gorbachev|GORBY|p
Emmanuel Macron|MACRON|p
Narendra Modi|MODI|p
Javier Milei|MILEI|p
Nayib Bukele|BUKELE|p
Volodymyr Zelensky|ZELENSKY|p
Angela Merkel|MERKEL|p
Justin Trudeau|TRUDEAU|p
Boris Johnson|BORIS|p
Bernie Sanders|BERNIE|p
Alexandria Ocasio-Cortez|AOC|p
JD Vance|VANCE|p
Neil Armstrong|ARMSTRONG|c
Buzz Aldrin|BUZZ|c
Yuri Gagarin|GAGARIN|c
Richard Feynman|FEYNMAN|c
Carl Sagan|SAGAN|c
Neil deGrasse Tyson|NDT|c
Thomas Edison|EDISON|c
Alexander Graham Bell|GRAHAMBELL|c
Louis Pasteur|PASTEUR|c
Gregor Mendel|MENDEL|c
Max Planck|PLANCK|c
Niels Bohr|BOHR|c
Werner Heisenberg|HEISENBERG|c
Johannes Kepler|KEPLER|c
Nicolaus Copernicus|COPERNICUS|c
Rosalind Franklin|ROSALIND|c
Sigmund Freud|FREUD|c
Carl Jung|JUNG|c
Archimedes|ARCHIMEDES|c
Pythagoras|PYTHAGORAS|c
Euclid|EUCLID|c
Ibn Sina|AVICENNA|c
Jane Goodall|GOODALL|c
Michio Kaku|KAKU|c
Bill Nye|NYE|c
Aristotle|ARISTOTLE|a
Plato|PLATO|a
Socrates|SOCRATES|a
Confucius|CONFUCIUS|a
Sun Tzu|SUNTZU|a
Friedrich Nietzsche|NIETZSCHE|a
Karl Marx|MARX|a
Homer|HOMER|a
Dante Alighieri|DANTE|a
Mark Twain|TWAIN|a
Ernest Hemingway|HEMINGWAY|a
George Orwell|ORWELL|a
Leo Tolstoy|TOLSTOY|a
Fyodor Dostoevsky|DOSTOEVSKY|a
Jalaluddin Rumi|RUMI|a
Edgar Allan Poe|POE|a
Agatha Christie|CHRISTIE|a
J.R.R. Tolkien|TOLKIEN|a
George R.R. Martin|GRRM|a
Stan Lee|STANLEE|a
Frida Kahlo|FRIDA|a
Salvador Dalí|DALI|a
Andy Warhol|WARHOL|a
Bob Ross|BOBROSS|a
Marco Polo|MARCOPOLO|h
Amelia Earhart|EARHART|h
Florence Nightingale|FLORENCE|h
Paul McCartney|MCCARTNEY|m
Mick Jagger|JAGGER|m
David Bowie|BOWIE|m
Prince Rogers Nelson|PRINCE|m
Elton John|ELTON|m
Frank Sinatra|SINATRA|m
Johann Sebastian Bach|BACH|m
Stevie Wonder|STEVIE|m
Bob Dylan|DYLAN|m
Dolly Parton|DOLLY|m
Tupac Shakur|TUPAC|m
Katy Perry|KATY|m
Miley Cyrus|MILEY|m
Nicki Minaj|NICKI|m
Cardi B|CARDIB|m
Post Malone|POSTY|m
Doja Cat|DOJA|m
Pharrell Williams|PHARRELL|m
Celine Dion|CELINE|m
Kylie Minogue|KYLIE|m
Jennifer Lopez|JLO|m
Alicia Keys|ALICIA|m
Usher Raymond|USHER|m
Jeon Jungkook|JUNGKOOK|m
Lalisa Manobal|LISA|m
Park Jae-sang|PSY|m
Rosalía|ROSALIA|m
Karol G|KAROLG|m
Tarkan Tevetoğlu|TARKAN|m
David Guetta|GUETTA|m
Enrique Iglesias|ENRIQUE|m
Denzel Washington|DENZEL|f
Ryan Reynolds|REYNOLDS|f
Ryan Gosling|GOSLING|f
Margot Robbie|MARGOT|f
Zendaya Coleman|ZENDAYA|f
Tom Holland|HOLLAND|f
Timothée Chalamet|CHALAMET|f
Pedro Pascal|PASCAL|f
Cillian Murphy|CILLIAN|f
Christopher Nolan|NOLAN|f
Steven Spielberg|SPIELBERG|f
Quentin Tarantino|TARANTINO|f
Martin Scorsese|SCORSESE|f
Audrey Hepburn|AUDREY|f
Meryl Streep|STREEP|f
Jim Carrey|CARREY|f
Eddie Murphy|EDDIE|f
Samuel L. Jackson|SAMUEL|f
Nicolas Cage|CAGE|f
Danny DeVito|DEVITO|f
Jason Statham|STATHAM|f
Vin Diesel|DIESEL|f
Gal Gadot|GADOT|f
Emma Watson|WATSON|f
Daniel Radcliffe|RADCLIFFE|f
Hugh Jackman|JACKMAN|f
Henry Cavill|CAVILL|f
Chris Hemsworth|HEMSWORTH|f
Kylie Jenner|JENNER|f
Paris Hilton|PARIS|f
Gordon Ramsay|RAMSAY|f
Bryan Cranston|CRANSTON|f
Jennifer Aniston|ANISTON|f
Matthew McConaughey|MATTHEW|f
Sydney Sweeney|SWEENEY|f
Jenna Ortega|JENNA|f
Shah Rukh Khan|SRK|f
Amitabh Bachchan|BIGB|f
Priyanka Chopra|PRIYANKA|f
Kevin Hart|HART|f
Conan O'Brien|CONAN|f
Jerry Seinfeld|SEINFELD|f
David Attenborough|SIRDAVID|f
Felix Kjellberg|PEWDIEPIE|i
Logan Paul|LOGAN|i
Jake Paul|JAKEPAUL|i
Olajide Olatunji|KSI|i
Darren Watkins Jr.|SPEED|i
Kai Cenat|KAI|i
Khaby Lame|KHABY|i
Joe Rogan|ROGAN|i
Tyler Blevins|NINJA|i
Félix Lengyel|XQC|i
Lex Fridman|LEX|i
Jordan Peterson|PETERSON|i
Tucker Carlson|TUCKER|i
David Goggins|GOGGINS|i
Gary Vaynerchuk|GARYVEE|i
Giannis Antetokounmpo|GIANNIS|s
Kevin Durant|DURANT|s
Patrick Mahomes|MAHOMES|s
Travis Kelce|KELCE|s
Kevin De Bruyne|KDB|s
Luka Modrić|MODRIC|s
Robert Lewandowski|LEWY|s
Arda Güler|ARDA|s
Manny Pacquiao|PACQUIAO|s
Garry Kasparov|KASPAROV|s
Pep Guardiola|PEP|s
José Mourinho|MOURINHO|s
Jürgen Klopp|KLOPP|s
Carlo Ancelotti|ANCELOTTI|s
Wayne Gretzky|GRETZKY|s
Babe Ruth|BABERUTH|s
Steve Ballmer|BALLMER|b
Howard Schultz|SCHULTZ|b
Jamie Dimon|DIMON|b
Reid Hoffman|HOFFMAN|t
Marc Andreessen|ANDREESSEN|t
Brian Chesky|CHESKY|t
Evan Spiegel|SPIEGEL|t
`;

/** `{ name, symbol, cat }` in fame order; `cat` is one of the CATEGORY_LINES keys. */
export const FAMOUS_PEOPLE = Object.freeze(LIST.trim().split("\n").map((l) => { const [name, symbol, cat] = l.split("|"); return Object.freeze({ name, symbol, cat }); }));

/** Why each kind of human matters, one line (the fallback description is "<Name>: <line>."). */
export const CATEGORY_LINES = Object.freeze({
  t: ["built the future while the rest of us were still loading", "turned lines of code into a whole new world", "the reason the future showed up early"],
  p: ["made history and made every newsroom on Earth print the name", "a name half the planet cheers and the other half argues about", "shaped nations, headlines and the group chat"],
  s: ["a once-in-a-generation athlete who made the impossible look routine", "the greatest-of-all-time debate starts and ends here", "turned a game into a worldwide religion"],
  m: ["the soundtrack of a billion lives", "one voice, every playlist on the planet", "turned songs into a worldwide movement"],
  f: ["a face the whole planet knows from the big screen", "box office gravity in human form", "the main character, on screen and off"],
  c: ["changed how humanity understands the universe", "a mind that rewrote what we thought we knew", "proof that one idea can move the whole world"],
  h: ["a name that outlived empires", "history did not just happen around them, they made it", "still quoted, still studied, still legendary"],
  b: ["built an empire out of a single idea", "turned ambition into one of the biggest fortunes on Earth", "the deal, the vision, the legend"],
  x: ["a legend of the chain, onchain since before it was cool", "every bull run carries a little of this human's work", "crypto history has this name all over it"],
  a: ["made work the world still lines up to see", "wrote and made things the world still quotes", "a genius whose work never went out of style"],
  i: ["turned a camera and a connection into a global stage", "the internet's main character", "millions tune in, every single time"],
});

/** Hype lines about a person (the "why", at most 140 characters with a 32-character name). `{N}` name, `{T}` $TICKER. */
export const HYPE_LINES = Object.freeze([
  "Eight billion people know {N}. Now they can trade {T}.",
  "{N} never needed an introduction. {T} doesn't either.",
  "Legends get statues. {N} gets {T}.",
  "If you know {N}, you already get {T}.",
  "The whole world already knows the name. Now it has a ticker: {T}.",
  "One of the most famous humans ever, finally onchain as {T}.",
]);

/** People known mainly for atrocities, terrorism, serial violence or sexual crimes: never a coin. */
export const PEOPLE_NEVER = Object.freeze([
  "adolf hitler", "hitler", "joseph stalin", "stalin", "pol pot", "osama bin laden", "bin laden", "osama", "mao zedong", "saddam hussein", "idi amin",
  "heinrich himmler", "himmler", "joseph goebbels", "goebbels", "benito mussolini", "mussolini", "kim jong un", "kim jong il", "abu bakr al baghdadi", "baghdadi",
  "charles manson", "ted bundy", "jeffrey dahmer", "jeffrey epstein", "epstein", "ghislaine maxwell", "harvey weinstein", "ted kaczynski", "timothy mcveigh",
  "anders breivik", "breivik", "brenton tarrant", "pablo escobar", "escobar", "ratko mladic", "slobodan milosevic", "radovan karadzic", "augusto pinochet", "pinochet",
]);
const NEVER_TERMS = PEOPLE_NEVER.map((t) => ({ words: wordsOf(t), squashed: normalizeWord(t) }));

/** The PEOPLE_NEVER term `text` names (whole word, or a multi-word term squashed; a ticker also at its start/end), or null. */
export function neverPerson(text, { symbol = false } = {}) {
  const squashed = normalizeWord(text);
  if (!squashed) return null;
  const words = new Set(wordsOf(text));
  for (const t of NEVER_TERMS) {
    if (t.words.length === 1 ? words.has(t.squashed) : squashed.includes(t.squashed)) return t.words.join(" ");
    if (symbol && t.squashed.length >= 4 && (squashed.startsWith(t.squashed) || squashed.endsWith(t.squashed))) return t.words.join(" ");
  }
  return null;
}

const SUFFIXES = new Set(["jr", "sr", "ii", "iii", "iv"]);
/**
 * One person, however the name is written: the first and last words of the normalised name, middle
 * names, initials and suffixes dropped ("Donald J. Trump" = "Donald Trump", "Martin Luther King Jr."
 * = "Martin King"); a single word stays itself ("Pelé" → "pele").
 */
export function personKey(name) {
  const w = String(name ?? "").split(/[\s.\-–—_/]+/).map(normalizeWord).filter((x) => x && !SUFFIXES.has(x));
  if (!w.length) return "";
  if (w.length === 1) return w[0];
  const rest = w.slice(1).filter((x) => x.length > 1);
  return `${w[0]} ${rest.length ? rest[rest.length - 1] : w[w.length - 1]}`;
}

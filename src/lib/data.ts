export type Role = "Veterinarian" | "Receptionist" | "Assistant" | "Admin";

export type Pet = {
  id: string;
  name: string;
  species: "Dog" | "Cat";
  breed: string;
  age: string;
  weight: string;
  owner: string;
  household: string;
  badges: string[];
  allergies: string[];
  conditions: string[];
  medications: string[];
};

export const pets: Pet[] = [
  {
    id: "buddy",
    name: "Buddy",
    species: "Dog",
    breed: "Golden Retriever",
    age: "4 years",
    weight: "28.4 kg",
    owner: "Ali Raza",
    household: "Raza household",
    badges: ["Active", "Vaccinated", "Allergies"],
    allergies: ["Penicillin"],
    conditions: ["Otitis externa, both ears"],
    medications: ["Amoxicillin 500 mg", "Ear drops"],
  },
  {
    id: "milo",
    name: "Milo",
    species: "Cat",
    breed: "Domestic Shorthair",
    age: "2 years",
    weight: "4.6 kg",
    owner: "Ali Raza",
    household: "Raza household",
    badges: ["Active", "Vaccinated"],
    allergies: [],
    conditions: [],
    medications: [],
  },
  {
    id: "luna",
    name: "Luna",
    species: "Cat",
    breed: "Siamese",
    age: "6 years",
    weight: "3.9 kg",
    owner: "Sara Khan",
    household: "Khan household",
    badges: ["Active", "Under treatment"],
    allergies: [],
    conditions: ["Hyperthyroidism"],
    medications: ["Methimazole 2.5 mg"],
  },
  {
    id: "coco",
    name: "Coco",
    species: "Dog",
    breed: "Beagle",
    age: "7 years",
    weight: "12.1 kg",
    owner: "Danish Ali",
    household: "Ali household",
    badges: ["Active", "Vaccinated"],
    allergies: ["Chicken protein"],
    conditions: ["Arthritis"],
    medications: ["Joint supplement"],
  },
];

export type EventType = "visit" | "vaccination" | "test" | "medication";

export type TimelineEntry = {
  id: string;
  petId: string;
  date: string;
  type: EventType;
  title: string;
  clinic: string;
  vet: string;
  summary: string;
  careCard?: string;
};

export const timeline: TimelineEntry[] = [
  {
    id: "e1",
    petId: "buddy",
    date: "14 Oct 2026",
    type: "visit",
    title: "Consultation for ear infection",
    clinic: "Pawfolio Partner Clinic",
    vet: "Dr. Ahmed",
    summary: "Redness in both ears. Started Amoxicillin and ear drops, recheck on Friday.",
    careCard:
      "Give Amoxicillin 500 mg, one tablet twice daily for 10 days. Apply two drops in each ear twice daily. Finish the full course even if the ears look better. Recheck on Friday if redness persists.",
  },
  {
    id: "e2",
    petId: "buddy",
    date: "12 Oct 2026",
    type: "test",
    title: "Ear cytology and skin scrap",
    clinic: "Pawfolio Partner Clinic",
    vet: "Dr. Ahmed",
    summary: "Samples collected and sent to the lab. Results are attached to documents.",
  },
  {
    id: "e3",
    petId: "buddy",
    date: "02 Sep 2026",
    type: "vaccination",
    title: "Annual booster",
    clinic: "Pawfolio Partner Clinic",
    vet: "Dr. Ahmed",
    summary: "DHPP and rabies booster given. No reaction observed during the visit.",
  },
  {
    id: "e4",
    petId: "buddy",
    date: "18 Jul 2026",
    type: "medication",
    title: "Earlier ear drop course completed",
    clinic: "Pawfolio Partner Clinic",
    vet: "Dr. Ahmed",
    summary: "Owner reported the full course was given on schedule. No missed doses logged.",
  },
  {
    id: "m1",
    petId: "milo",
    date: "02 Sep 2026",
    type: "vaccination",
    title: "Annual booster",
    clinic: "Pawfolio Partner Clinic",
    vet: "Dr. Ahmed",
    summary: "FVRCP and rabies given. Next booster due September 2027.",
  },
  {
    id: "m2",
    petId: "milo",
    date: "20 Jun 2026",
    type: "visit",
    title: "Dental check",
    clinic: "Pawfolio Partner Clinic",
    vet: "Dr. Ahmed",
    summary: "Mild tartar build-up. Cleaning scheduled for next quarter.",
  },
  {
    id: "l1",
    petId: "luna",
    date: "10 Oct 2026",
    type: "visit",
    title: "Thyroid review",
    clinic: "Pawfolio Partner Clinic",
    vet: "Dr. Ahmed",
    summary: "Weight stable. Methimazole continued at 2.5 mg twice daily.",
    careCard:
      "Give Methimazole 2.5 mg, one tablet twice daily with food. Report reduced appetite or vomiting to the clinic.",
  },
  {
    id: "l2",
    petId: "luna",
    date: "08 Oct 2026",
    type: "test",
    title: "T4 panel",
    clinic: "Pawfolio Partner Clinic",
    vet: "Dr. Ahmed",
    summary: "Results within the target range for the current dose.",
  },
  {
    id: "c1",
    petId: "coco",
    date: "28 Sep 2026",
    type: "visit",
    title: "Arthritis review",
    clinic: "Pawfolio Partner Clinic",
    vet: "Dr. Ahmed",
    summary: "Joint supplement continued. Weight plan shared with the owner.",
  },
];

export type DoseLog = "given" | "skipped" | "upcoming";

export type Medication = {
  id: string;
  petId: string;
  name: string;
  dose: string;
  route: string;
  frequency: string;
  daysTotal: number;
  daysLeft: number;
  week: DoseLog[];
};

export const medications: Medication[] = [
  {
    id: "med1",
    petId: "buddy",
    name: "Amoxicillin 500 mg",
    dose: "1 tablet",
    route: "Oral",
    frequency: "Twice daily",
    daysTotal: 10,
    daysLeft: 7,
    week: ["given", "given", "given", "given", "skipped", "given", "upcoming"],
  },
  {
    id: "med2",
    petId: "buddy",
    name: "Ear drops",
    dose: "2 drops per ear",
    route: "In ear",
    frequency: "Twice daily",
    daysTotal: 10,
    daysLeft: 7,
    week: ["given", "given", "given", "given", "given", "given", "upcoming"],
  },
  {
    id: "med3",
    petId: "luna",
    name: "Methimazole 2.5 mg",
    dose: "1 tablet",
    route: "Oral",
    frequency: "Twice daily",
    daysTotal: 30,
    daysLeft: 18,
    week: ["given", "given", "skipped", "given", "given", "given", "upcoming"],
  },
  {
    id: "med4",
    petId: "coco",
    name: "Joint supplement",
    dose: "1 chew",
    route: "Oral",
    frequency: "Once daily",
    daysTotal: 60,
    daysLeft: 22,
    week: ["given", "given", "given", "given", "given", "given", "upcoming"],
  },
];

export type DocStatus = "Verified" | "Unverified";

export type Doc = {
  id: string;
  petId: string;
  name: string;
  kind: "PDF" | "Image";
  date: string;
  status: DocStatus;
};

export const documents: Doc[] = [
  { id: "d1", petId: "buddy", name: "Ear cytology lab report", kind: "PDF", date: "13 Oct 2026", status: "Verified" },
  { id: "d2", petId: "buddy", name: "Skin scrap result", kind: "Image", date: "12 Oct 2026", status: "Verified" },
  { id: "d3", petId: "buddy", name: "Owner photo: ear redness", kind: "Image", date: "15 Oct 2026", status: "Unverified" },
  { id: "d4", petId: "milo", name: "Vaccination card scan", kind: "Image", date: "02 Sep 2026", status: "Verified" },
  { id: "d5", petId: "luna", name: "T4 panel result", kind: "PDF", date: "09 Oct 2026", status: "Unverified" },
];

export type AdherenceLog = { who: string; status: "Given" | "Skipped" | "Pending"; at: string };

export type CareOrder = {
  id: string;
  petName: string;
  medicine: string;
  dose: string;
  frequency: string;
  nextDue: string;
  logs: AdherenceLog[];
};

export const careOrders: CareOrder[] = [
  {
    id: "o1",
    petName: "Buddy",
    medicine: "Amoxicillin 500 mg",
    dose: "1 tablet",
    frequency: "Twice daily",
    nextDue: "Today 20:00",
    logs: [
      { who: "Ali Raza", status: "Given", at: "Today 08:12" },
      { who: "Ali Raza", status: "Given", at: "Yesterday 20:04" },
    ],
  },
  {
    id: "o2",
    petName: "Buddy",
    medicine: "Ear drops",
    dose: "2 drops per ear",
    frequency: "Twice daily",
    nextDue: "Today 20:00",
    logs: [{ who: "Ali Raza", status: "Given", at: "Today 08:15" }],
  },
  {
    id: "o3",
    petName: "Luna",
    medicine: "Methimazole 2.5 mg",
    dose: "1 tablet",
    frequency: "Twice daily",
    nextDue: "Today 18:00",
    logs: [
      { who: "Sara Khan", status: "Given", at: "Today 08:05" },
      { who: "Sara Khan", status: "Skipped", at: "Yesterday 18:40" },
    ],
  },
  {
    id: "o4",
    petName: "Coco",
    medicine: "Joint supplement",
    dose: "1 chew",
    frequency: "Once daily",
    nextDue: "Tomorrow 09:00",
    logs: [{ who: "Danish Ali", status: "Pending", at: "Due tomorrow" }],
  },
];

export type CareTask = {
  id: string;
  kind: "Refill request" | "Owner note" | "Test follow-up";
  petName: string;
  detail: string;
  priority: "High" | "Medium" | "Low";
  at: string;
};

export const careTasks: CareTask[] = [
  {
    id: "k1",
    kind: "Refill request",
    petName: "Buddy",
    detail: "Owner requested an early refill. The current course ends in 7 days.",
    priority: "High",
    at: "2h ago",
  },
  {
    id: "k2",
    kind: "Owner note",
    petName: "Luna",
    detail: "Owner reports reduced appetite since Monday. No vomiting observed.",
    priority: "Medium",
    at: "5h ago",
  },
  {
    id: "k3",
    kind: "Test follow-up",
    petName: "Buddy",
    detail: "Ear cytology recheck is due with the Friday visit.",
    priority: "Medium",
    at: "1d ago",
  },
  {
    id: "k4",
    kind: "Refill request",
    petName: "Coco",
    detail: "Joint supplement refill needed for next month.",
    priority: "Low",
    at: "2d ago",
  },
];

export type Appointment = {
  id: string;
  petName: string;
  ownerName: string;
  time: string;
  visitType: string;
};

export const appointments: Appointment[] = [
  { id: "a1", petName: "Buddy", ownerName: "Ali Raza", time: "09:30", visitType: "Recheck" },
  { id: "a2", petName: "Luna", ownerName: "Sara Khan", time: "10:15", visitType: "Follow-up" },
  { id: "a3", petName: "Coco", ownerName: "Danish Ali", time: "11:00", visitType: "Vaccination" },
  { id: "a4", petName: "Milo", ownerName: "Ali Raza", time: "16:45", visitType: "Dental cleaning" },
];

export type AiDraft = {
  id: string;
  petName: string;
  source: "Dictation" | "Uploaded report";
  fields: { label: string; value: string; ok: boolean }[];
  missing: string[];
};

export const aiDrafts: AiDraft[] = [
  {
    id: "dr1",
    petName: "Buddy",
    source: "Dictation",
    fields: [
      { label: "Presenting complaint", value: "Ear redness and head shaking", ok: true },
      { label: "Weight", value: "28.4 kg", ok: true },
      { label: "Medicine", value: "Amoxicillin 500 mg", ok: true },
      { label: "Frequency", value: "Twice daily", ok: true },
    ],
    missing: ["Duration", "Follow-up date"],
  },
  {
    id: "dr2",
    petName: "Luna",
    source: "Uploaded report",
    fields: [
      { label: "Test", value: "T4 panel", ok: true },
      { label: "Result", value: "Within target range", ok: true },
      { label: "Medicine", value: "Methimazole 2.5 mg", ok: true },
    ],
    missing: ["Dose confirmation"],
  },
];

export type Staff = { id: string; name: string; role: Role; email: string; status: "Active" | "Invited" };

export const staff: Staff[] = [
  { id: "s1", name: "Dr. Ahmed", role: "Veterinarian", email: "dr.ahmed@pawfolio.ai", status: "Active" },
  { id: "s2", name: "Hina Asif", role: "Receptionist", email: "hina@pawfolio.ai", status: "Active" },
  { id: "s3", name: "Bilal Khan", role: "Assistant", email: "bilal@pawfolio.ai", status: "Active" },
  { id: "s4", name: "Sana Malik", role: "Admin", email: "sana@pawfolio.ai", status: "Active" },
  { id: "s5", name: "Usman Tariq", role: "Veterinarian", email: "usman@pawfolio.ai", status: "Invited" },
];

export const registrationQueue = [
  { id: "rq1", label: "Khan household", detail: "Invitation sent, waiting for the owner to claim the household." },
  { id: "rq2", label: "Malik household, new puppy", detail: "Duplicate check passed. Ready to register." },
  { id: "rq3", label: "Check-in: Coco with Danish Ali", detail: "In the waiting room for the 11:00 vaccination." },
];

export const intakeTasks = [
  { id: "it1", label: "Weigh Buddy before the 09:30 recheck", detail: "Last recorded weight 28.4 kg on 14 Oct 2026." },
  { id: "it2", label: "Scan and attach the Luna lab report", detail: "Paper report received at the front desk." },
  { id: "it3", label: "Record temperature at the Coco vaccination visit", detail: "Intake sheet pending for the 11:00 slot." },
];

export type TodayAction = {
  id: string;
  petId: string;
  medicine: string;
  dose: string;
  due: string;
  logged: { status: "Given" | "Skipped"; at: string } | null;
};

export const todayActions: TodayAction[] = [
  { id: "t1", petId: "buddy", medicine: "Amoxicillin 500 mg", dose: "1 tablet", due: "08:00", logged: { status: "Given", at: "08:12" } },
  { id: "t2", petId: "buddy", medicine: "Ear drops", dose: "2 drops per ear", due: "08:00", logged: { status: "Given", at: "08:15" } },
  { id: "t3", petId: "buddy", medicine: "Amoxicillin 500 mg", dose: "1 tablet", due: "20:00", logged: null },
  { id: "t4", petId: "buddy", medicine: "Ear drops", dose: "2 drops per ear", due: "20:00", logged: null },
];

export const ownerPets = pets.filter((p) => p.household === "Raza household");

export function petById(id: string): Pet | undefined {
  return pets.find((p) => p.id === id);
}

export function eventsFor(petId: string): TimelineEntry[] {
  return timeline.filter((e) => e.petId === petId);
}

export function medsFor(petId: string): Medication[] {
  return medications.filter((m) => m.petId === petId);
}

export function docsFor(petId: string): Doc[] {
  return documents.filter((d) => d.petId === petId);
}

export const eventTone: Record<EventType, { dot: string; chip: string; label: string }> = {
  visit: { dot: "bg-primary", chip: "bg-primary/10 text-primary-dark", label: "Visit" },
  vaccination: { dot: "bg-success", chip: "bg-success/10 text-green-700", label: "Vaccination" },
  test: { dot: "bg-warning", chip: "bg-warning/20 text-yellow-700", label: "Test" },
  medication: { dot: "bg-accent", chip: "bg-accent/10 text-accent-dark", label: "Medication" },
};
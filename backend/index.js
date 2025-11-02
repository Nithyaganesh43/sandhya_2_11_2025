require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const PDFDocument = require('pdfkit');

const app = express();
app.use(cors({ origin: true, credentials: true }));
app.use(express.json());
app.use(cookieParser());

const MONGO_URI = process.env.MONGO_URI;
const PORT = process.env.PORT || 10000;

mongoose
  .connect(MONGO_URI)
  .then(async () => {
    console.log('Mongo connected');
    // clear all records
    await mongoose.connection.db.dropDatabase();
    // seed defaults
    const Employee = mongoose.model('Employee', employeeSchema);
    await Employee.insertMany([
      {
        name: 'Admin',
        email: 'admin@pavakie.com',
        password: 'admin123',
        role: 'admin',
        monthlySalary: 50000,
        designation: 'HR Manager',
      },
      {
        name: 'Sample Employee',
        email: 'employee@pavakie.com',
        password: 'emp123',
        role: 'employee',
        monthlySalary: 30000,
        designation: 'Developer',
      },
    ]);
    console.log('Database cleared & seeded');
  })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });

// Schemas
const employeeSchema = new mongoose.Schema(
  {
    name: String,
    email: { type: String, unique: true, required: true },
    password: { type: String, required: true },
    role: { type: String, enum: ['admin', 'employee'], default: 'employee' },
    monthlySalary: { type: Number, default: 30000 },
    designation: String,
    joiningDate: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

const attendanceSchema = new mongoose.Schema(
  {
    employee: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Employee',
      required: true,
    },
    date: { type: Date, required: true },
    status: {
      type: String,
      enum: ['present', 'absent', 'leave'],
      default: 'present',
    },
  },
  { timestamps: true }
);

const Employee = mongoose.model('Employee', employeeSchema);
const Attendance = mongoose.model('Attendance', attendanceSchema);

function startOfMonth(y, m) {
  return new Date(y, m - 1, 1);
}
function endOfMonth(y, m) {
  return new Date(y, m, 0, 23, 59, 59, 999);
}
async function calcSalaryForMonth(id, y, m) {
  const emp = await Employee.findById(id).lean();
  if (!emp) throw new Error('Employee not found');
  const from = startOfMonth(y, m),
    to = endOfMonth(y, m);
  const presentCount = await Attendance.countDocuments({
    employee: id,
    date: { $gte: from, $lte: to },
    status: 'present',
  });
  const salary = emp.monthlySalary * (presentCount / 30);
  return {
    employee: emp,
    year: y,
    month: m,
    presentDays: presentCount,
    calculatedSalary: Math.round(salary),
  };
}

// Cookie-auth
async function auth(req, res, next) {
  const email = req.cookies.userEmail;
  if (!email) return res.status(401).json({ error: 'not logged in' });
  const user = await Employee.findOne({ email });
  if (!user) return res.status(401).json({ error: 'invalid session' });
  req.user = user;
  next();
}

// Health
app.get('/', (req, res) =>
  res.json({ ok: true, message: 'Payroll Server Healthy' })
);

// Auth
app.post('/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await Employee.findOne({ email, password });
    if (!user)
      return res.status(401).json({ error: 'invalid email or password' });
    res.cookie('userEmail', user.email, { httpOnly: true, sameSite: 'lax' });
    res.json({ ok: true, message: 'Login success', user });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/auth/logout', (req, res) => {
  res.clearCookie('userEmail');
  res.json({ ok: true, message: 'Logged out' });
});

// Employees
app.get('/employees', auth, async (req, res) => {
  res.json({ ok: true, employees: await Employee.find().lean() });
});

// Attendance
app.post('/attendance', auth, async (req, res) => {
  try {
    const { employee, date, status } = req.body;
    if (!employee || !date)
      return res.status(400).json({ error: 'employee and date required' });
    const d = new Date(date);
    const att = await Attendance.findOneAndUpdate(
      {
        employee,
        date: {
          $gte: new Date(d.setHours(0, 0, 0, 0)),
          $lte: new Date(d.setHours(23, 59, 59, 999)),
        },
      },
      { employee, status, date: d },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    );
    res.json({ ok: true, attendance: att });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Salary
app.get('/salary/generate', auth, async (req, res) => {
  try {
    const { employeeId, month, year } = req.query;
    if (!employeeId || !month || !year)
      return res.status(400).json({ error: 'employeeId,month,year required' });
    res.json({
      ok: true,
      salarySlip: await calcSalaryForMonth(employeeId, +year, +month),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PDF Salary
app.get('/salary/pdf', auth, async (req, res) => {
  try {
    const { employeeId, month, year } = req.query;
    const slip = await calcSalaryForMonth(employeeId, +year, +month);
    const doc = new PDFDocument({ size: 'A4' });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename=salary_${employeeId}_${year}_${month}.pdf`
    );
    doc.fontSize(20).text('Salary Slip', { align: 'center' }).moveDown();
    doc.fontSize(12).text(`Employee: ${slip.employee.name}`);
    doc.text(`Email: ${slip.employee.email}`);
    doc.text(`Month: ${slip.month}/${slip.year}`);
    doc.text(`Present Days: ${slip.presentDays}`);
    doc.text(`Calculated Salary: ${slip.calculatedSalary}`);
    doc.end();
    doc.pipe(res);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => console.log('Server running on port', PORT));

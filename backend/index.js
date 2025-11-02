require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const PDFDocument = require('pdfkit');

const app = express();
app.use(cors({ origin: true, credentials: true }));
app.use(express.json());

const MONGO_URI = process.env.MONGO_URI;
const PORT = process.env.PORT || 10000;

//------------------ SCHEMAS ------------------//
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

//------------------ UTILS ------------------//
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

//------------------ AUTH ------------------//
async function auth(req, res, next) {
  const email = req.headers['x-user-email'];
  if (!email) return res.status(401).json({ error: 'not logged in' });
  const user = await Employee.findOne({ email });
  if (!user) return res.status(401).json({ error: 'invalid user' });
  req.user = user;
  next();
}

//------------------ DB CONNECTION ------------------//
mongoose
  .connect(MONGO_URI)
  .then(async () => {
    console.log('Mongo connected');
    await mongoose.connection.db.dropDatabase();
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

//------------------ ROUTES ------------------//
app.get('/', (req, res) =>
  res.json({ ok: true, message: 'Payroll Server Healthy' })
);

app.post('/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await Employee.findOne({ email, password });
    if (!user)
      return res.status(401).json({ error: 'invalid email or password' });
    res.json({ ok: true, message: 'Login success', user });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/employees', auth, async (req, res) => {
  res.json({ ok: true, employees: await Employee.find().lean() });
});

app.post('/employees', auth, async (req, res) => {
  try {
    const { name, email, password, role, monthlySalary, designation } =
      req.body;
    if (!name || !email)
      return res.status(400).json({ error: 'name and email required' });
    const newEmp = await Employee.create({
      name,
      email,
      password: password || 'emp123',
      role: role || 'employee',
      monthlySalary: monthlySalary || 30000,
      designation: designation || '',
    });
    res.json({ ok: true, employee: newEmp });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
app.delete('/employees/:id', auth, async (req, res) => {
  try {
    const { id } = req.params;
    const deleted = await Employee.findByIdAndDelete(id);
    if (!deleted) return res.status(404).json({ error: 'Employee not found' });
    res.json({ ok: true, message: 'Employee deleted successfully' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

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

//------------------ SERVER ------------------//
app.listen(PORT, () => console.log('Server running on port', PORT));

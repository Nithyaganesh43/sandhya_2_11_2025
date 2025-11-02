require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const PDFDocument = require('pdfkit');

const app = express();
app.use(cors());
app.use(express.json());

const MONGO_URI = process.env.MONGO_URI;
const PORT = process.env.PORT || 10000;

mongoose
  .connect(MONGO_URI)
  .then(() => console.log('Mongo connected'))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });

// Schemas
const employeeSchema = new mongoose.Schema(
  {
    name: String,
    email: { type: String, unique: true, required: true },
    password: { type: String, required: true }, // plain text for demo
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

// Helpers
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

// Routes
app.get('/', (req, res) =>
  res.json({ ok: true, message: 'Payroll demo backend running' })
);

// Auth routes
app.post('/auth/register', async (req, res) => {
  try {
    const { name, email, password, role, monthlySalary, designation } =
      req.body;
    if (!email || !password)
      return res.status(400).json({ error: 'email and password required' });
    const exists = await Employee.findOne({ email });
    if (exists) return res.status(400).json({ error: 'user already exists' });
    const emp = new Employee({
      name,
      email,
      password,
      role,
      monthlySalary,
      designation,
    });
    await emp.save();
    res.json({ ok: true, message: 'Registered', user: emp });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await Employee.findOne({ email, password }); // direct match
    if (!user)
      return res.status(401).json({ error: 'invalid email or password' });
    res.json({ ok: true, message: 'Login success', user });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Employees CRUD
app.post('/employees', async (req, res) => {
  try {
    const emp = new Employee(req.body);
    await emp.save();
    res.json({ ok: true, employee: emp });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
app.get('/employees', async (req, res) => {
  try {
    res.json({ ok: true, employees: await Employee.find().lean() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
app.put('/employees/:id', async (req, res) => {
  try {
    const emp = await Employee.findByIdAndUpdate(req.params.id, req.body, {
      new: true,
    }).lean();
    if (!emp) return res.status(404).json({ error: 'not found' });
    res.json({ ok: true, employee: emp });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
app.delete('/employees/:id', async (req, res) => {
  try {
    await Attendance.deleteMany({ employee: req.params.id });
    const emp = await Employee.findByIdAndDelete(req.params.id).lean();
    if (!emp) return res.status(404).json({ error: 'not found' });
    res.json({ ok: true, deleted: emp });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Attendance
app.post('/attendance', async (req, res) => {
  try {
    const { employee, date, status } = req.body;
    if (!employee || !date)
      return res.status(400).json({ error: 'employee and date required' });
    const d = new Date(date);
    const att = await Attendance.findOneAndUpdate(
      {
        employee,
        date: {
          $gte: new Date(
            d.getFullYear(),
            d.getMonth(),
            d.getDate(),
            0,
            0,
            0,
            0
          ),
          $lte: new Date(
            d.getFullYear(),
            d.getMonth(),
            d.getDate(),
            23,
            59,
            59,
            999
          ),
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

app.get('/attendance', async (req, res) => {
  try {
    const { employeeId, month, year } = req.query;
    const q = {};
    if (employeeId) q.employee = employeeId;
    if (month && year)
      q.date = {
        $gte: startOfMonth(+year, +month),
        $lte: endOfMonth(+year, +month),
      };
    res.json({
      ok: true,
      attendance: await Attendance.find(q).populate('employee').lean(),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Salary + Dashboard
app.get('/salary/generate', async (req, res) => {
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
app.get('/salary/pdf', async (req, res) => {
  try {
    const { employeeId, month, year } = req.query;
    if (!employeeId || !month || !year)
      return res.status(400).json({ error: 'employeeId,month,year required' });
    const slip = await calcSalaryForMonth(employeeId, +year, +month);
    const doc = new PDFDocument({ size: 'A4' });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename=salary_${employeeId}_${year}_${month}.pdf`
    );
    doc.fontSize(20).text('Salary Slip', { align: 'center' });
    doc.moveDown();
    doc.fontSize(12).text(`Employee: ${slip.employee.name}`);
    doc.text(`Email: ${slip.employee.email}`);
    doc.text(`Designation: ${slip.employee.designation}`);
    doc.text(`Month: ${slip.month}/${slip.year}`);
    doc.text(`Present Days: ${slip.presentDays}`);
    doc.text(`Monthly Salary: ${slip.employee.monthlySalary}`);
    doc.text(`Calculated Salary: ${slip.calculatedSalary}`);
    doc.end();
    doc.pipe(res);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/dashboard', async (req, res) => {
  try {
    const { month, year } = req.query;
    const m = month ? +month : new Date().getMonth() + 1;
    const y = year ? +year : new Date().getFullYear();
    const totalEmployees = await Employee.countDocuments();
    const from = startOfMonth(y, m),
      to = endOfMonth(y, m);
    const present = await Attendance.countDocuments({
      date: { $gte: from, $lte: to },
      status: 'present',
    });
    const leave = await Attendance.countDocuments({
      date: { $gte: from, $lte: to },
      status: 'leave',
    });
    const emps = await Employee.find().lean();
    let totalSalary = 0;
    for (const e of emps) {
      const presentDays = await Attendance.countDocuments({
        employee: e._id,
        date: { $gte: from, $lte: to },
        status: 'present',
      });
      totalSalary += Math.round(e.monthlySalary * (presentDays / 30));
    }
    res.json({
      ok: true,
      month: m,
      year: y,
      totalEmployees,
      present,
      leave,
      totalSalary,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Seed defaults
app.post('/seed-default', async (req, res) => {
  try {
    if (!(await Employee.findOne({ email: 'admin@pavakie.com' })))
      await new Employee({
        name: 'Admin',
        email: 'admin@pavakie.com',
        password: 'admin123',
        role: 'admin',
        monthlySalary: 50000,
        designation: 'HR Manager',
      }).save();
    if (!(await Employee.findOne({ email: 'employee@pavakie.com' })))
      await new Employee({
        name: 'Sample Employee',
        email: 'employee@pavakie.com',
        password: 'emp123',
        role: 'employee',
        monthlySalary: 30000,
        designation: 'Developer',
      }).save();
    res.json({ ok: true, message: 'seeded' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => console.log('Server running on port', PORT));

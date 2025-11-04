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
    name: { type: String, required: true },
    username: { type: String, unique: true, required: true },
    password: { type: String, required: true },
    role: { type: String, enum: ['admin', 'employee'], default: 'employee' },
    salary: { type: Number, default: 30000 },
    empId: { type: String, unique: true, required: true },
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
      enum: ['present', 'absent'],
      default: 'present',
    },
  },
  { timestamps: true }
);

// Create unique index for employee + date combination
attendanceSchema.index({ employee: 1, date: 1 }, { unique: true });

const Employee = mongoose.model('Employee', employeeSchema);
const Attendance = mongoose.model('Attendance', attendanceSchema);

//------------------ UTILITY FUNCTIONS ------------------//
function startOfMonth(y, m) {
  return new Date(y, m - 1, 1);
}

function endOfMonth(y, m) {
  return new Date(y, m, 0, 23, 59, 59, 999);
}

function startOfDay(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

function endOfDay(date) {
  const d = new Date(date);
  d.setHours(23, 59, 59, 999);
  return d;
}

async function calculateSalary(employeeId, year, month) {
  const emp = await Employee.findById(employeeId).lean();
  if (!emp) throw new Error('Employee not found');

  const from = startOfMonth(year, month);
  const to = endOfMonth(year, month);

  const presentDays = await Attendance.countDocuments({
    employee: employeeId,
    date: { $gte: from, $lte: to },
    status: 'present',
  });

  // Calculate salary: (monthlySalary / 30) * presentDays
  const perDaySalary = emp.salary / 30;
  const calculatedSalary = perDaySalary * presentDays;

  return {
    employee: emp,
    year,
    month,
    presentDays,
    totalDaysInMonth: new Date(year, month, 0).getDate(),
    baseSalary: emp.salary,
    perDaySalary: Math.round(perDaySalary * 100) / 100,
    calculatedSalary: Math.round(calculatedSalary * 100) / 100,
  };
}

//------------------ AUTHENTICATION MIDDLEWARE ------------------//
async function authenticate(req, res, next) {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(401).json({
        ok: false,
        error: 'Username and password required in request body',
      });
    }

    const user = await Employee.findOne({ username, password });

    if (!user) {
      return res.status(401).json({
        ok: false,
        error: 'Invalid username or password',
      });
    }

    req.user = user;
    next();
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
}

// Admin-only middleware
function adminOnly(req, res, next) {
  if (req.user.role !== 'admin') {
    return res.status(403).json({
      ok: false,
      error: 'Access denied. Admin privileges required.',
    });
  }
  next();
}

// Employee-only middleware
function employeeOnly(req, res, next) {
  if (req.user.role !== 'employee') {
    return res.status(403).json({
      ok: false,
      error: 'Access denied. Employee access only.',
    });
  }
  next();
}

//------------------ DB CONNECTION & SEEDING ------------------//
mongoose
  .connect(MONGO_URI)
  .then(async () => {
    console.log('MongoDB connected successfully');

    // Drop database and seed admin
    await mongoose.connection.db.dropDatabase();
    console.log('Database cleared');

    // Create default admin
    const admin = await Employee.create({
      name: 'System Admin',
      username: 'admin',
      password: 'admin123',
      role: 'admin',
      salary: 50000,
      empId: 'ADMIN001',
    });

    console.log('✓ Default admin created');
    console.log('  Username: admin');
    console.log('  Password: admin123');
  })
  .catch((e) => {
    console.error('MongoDB connection error:', e);
    process.exit(1);
  });

//------------------ ROUTES ------------------//

// Health check
app.get('/', (req, res) => {
  res.json({
    ok: true,
    message: 'Payroll Management System - Server Running',
    timestamp: new Date().toISOString(),
  });
});

//------------------ ADMIN LOGIN ------------------//
app.post('/admin/login', async (req, res) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({
        ok: false,
        error: 'Username and password required',
      });
    }

    const admin = await Employee.findOne({
      username,
      password,
      role: 'admin',
    }).select('-password');

    if (!admin) {
      return res.status(401).json({
        ok: false,
        error: 'Invalid admin credentials',
      });
    }

    res.json({
      ok: true,
      message: 'Admin login successful',
      user: admin,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

//------------------ EMPLOYEE CRUD (ADMIN ONLY) ------------------//

// Create Employee
app.post(
  '/admin/employees/create',
  authenticate,
  adminOnly,
  async (req, res) => {
    try {
      // FIX: Read from 'username_new' and 'password_new' for the new employee
      const { name, username_new, password_new, salary, empId } = req.body;

      // FIX: Validate the new variables
      if (!name || !username_new || !password_new || !empId) {
        return res.status(400).json({
          ok: false,
          error:
            'Name, username_new, password_new, and empId are required for the new employee',
        });
      }

      // Check if username or empId already exists
      const existingEmp = await Employee.findOne({
        // FIX: Check against username_new
        $or: [{ username: username_new }, { empId }],
      });

      if (existingEmp) {
        return res.status(400).json({
          ok: false,
          error: 'Username or Employee ID already exists',
        });
      }

      const newEmployee = await Employee.create({
        name,
        username: username_new, // FIX: Save with username_new
        password: password_new, // FIX: Save with password_new
        role: 'employee',
        salary: salary || 30000,
        empId,
      });

      const employeeData = newEmployee.toObject();
      delete employeeData.password;

      res.json({
        ok: true,
        message: 'Employee created successfully',
        employee: employeeData,
        credentials: {
          username: username_new, // FIX: Return the correct new credentials
          password: password_new,
        },
      });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  }
);

// Get All Employees
app.post('/admin/employees/list', authenticate, adminOnly, async (req, res) => {
  try {
    const employees = await Employee.find({ role: 'employee' })
      .select('-password')
      .sort({ createdAt: -1 })
      .lean();

    res.json({
      ok: true,
      employees,
      count: employees.length,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Get Single Employee
app.post('/admin/employees/get', authenticate, adminOnly, async (req, res) => {
  try {
    const { employeeId } = req.body;

    if (!employeeId) {
      return res.status(400).json({ ok: false, error: 'Employee ID required' });
    }

    const employee = await Employee.findById(employeeId)
      .select('-password')
      .lean();

    if (!employee) {
      return res.status(404).json({ ok: false, error: 'Employee not found' });
    }

    res.json({ ok: true, employee });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});
// Update Employee
app.post(
  '/admin/employees/update',
  authenticate,
  adminOnly,
  async (req, res) => {
    try {
      // FIX: Use different names for the employee's new details
      const {
        employeeId,
        name,
        username_new,
        password_new,
        salary,
        empId,
      } = req.body;

      if (!employeeId) {
        return res
          .status(400)
          .json({ ok: false, error: 'Employee ID required' });
      }

      const updateData = {};
      if (name) updateData.name = name;
      if (username_new) updateData.username = username_new; // FIX
      if (password_new) updateData.password = password_new; // FIX
      if (salary) updateData.salary = salary;
      if (empId) updateData.empId = empId;

      const updated = await Employee.findByIdAndUpdate(employeeId, updateData, {
        new: true,
        runValidators: true,
      }).select('-password');

      if (!updated) {
        return res.status(404).json({ ok: false, error: 'Employee not found' });
      }

      res.json({
        ok: true,
        message: 'Employee updated successfully',
        employee: updated,
      });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  }
);
// Delete Employee
app.post(
  '/admin/employees/delete',
  authenticate,
  adminOnly,
  async (req, res) => {
    try {
      const { employeeId } = req.body;

      if (!employeeId) {
        return res
          .status(400)
          .json({ ok: false, error: 'Employee ID required' });
      }

      const deleted = await Employee.findByIdAndDelete(employeeId);

      if (!deleted) {
        return res.status(404).json({ ok: false, error: 'Employee not found' });
      }

      // Also delete all attendance records for this employee
      await Attendance.deleteMany({ employee: employeeId });

      res.json({
        ok: true,
        message: 'Employee and related records deleted successfully',
      });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  }
);

//------------------ ATTENDANCE MANAGEMENT (ADMIN ONLY) ------------------//

// Mark Attendance
app.post(
  '/admin/attendance/mark',
  authenticate,
  adminOnly,
  async (req, res) => {
    try {
      const { employeeId, date, status } = req.body;

      if (!employeeId || !date) {
        return res.status(400).json({
          ok: false,
          error: 'Employee ID and date required',
        });
      }

      if (status && !['present', 'absent'].includes(status)) {
        return res.status(400).json({
          ok: false,
          error: 'Status must be either "present" or "absent"',
        });
      }

      // Check if employee exists
      const employee = await Employee.findById(employeeId);
      if (!employee) {
        return res.status(404).json({ ok: false, error: 'Employee not found' });
      }

      const attendanceDate = startOfDay(new Date(date));

      // Use findOneAndUpdate with upsert to avoid duplicates
      const attendance = await Attendance.findOneAndUpdate(
        {
          employee: employeeId,
          date: {
            $gte: startOfDay(attendanceDate),
            $lte: endOfDay(attendanceDate),
          },
        },
        {
          employee: employeeId,
          date: attendanceDate,
          status: status || 'present',
        },
        {
          new: true,
          upsert: true,
          setDefaultsOnInsert: true,
        }
      ).populate('employee', 'name empId username');

      res.json({
        ok: true,
        message: 'Attendance marked successfully',
        attendance,
      });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  }
);

// Get Attendance for Employee (Admin can view any employee)
app.post(
  '/admin/attendance/view',
  authenticate,
  adminOnly,
  async (req, res) => {
    try {
      const { employeeId, month, year } = req.body;

      if (!employeeId) {
        return res
          .status(400)
          .json({ ok: false, error: 'Employee ID required' });
      }

      let query = { employee: employeeId };

      if (month && year) {
        const from = startOfMonth(+year, +month);
        const to = endOfMonth(+year, +month);
        query.date = { $gte: from, $lte: to };
      }

      const attendance = await Attendance.find(query)
        .sort({ date: -1 })
        .populate('employee', 'name empId username')
        .lean();

      const presentDays = attendance.filter(
        (a) => a.status === 'present'
      ).length;
      const absentDays = attendance.filter((a) => a.status === 'absent').length;

      res.json({
        ok: true,
        attendance,
        summary: {
          totalRecords: attendance.length,
          presentDays,
          absentDays,
        },
      });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  }
);

//------------------ PAYSLIP GENERATION (ADMIN) ------------------//

// Generate Payslip
app.post(
  '/admin/payslip/generate',
  authenticate,
  adminOnly,
  async (req, res) => {
    try {
      const { employeeId, month, year } = req.body;

      if (!employeeId || !month || !year) {
        return res.status(400).json({
          ok: false,
          error: 'Employee ID, month, and year required',
        });
      }

      const payslip = await calculateSalary(employeeId, +year, +month);

      res.json({
        ok: true,
        payslip,
      });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  }
);
//------------------ PAYSLIP PDF (PROFESSIONAL FORMAT) ------------------//
app.post('/admin/payslip/pdf', authenticate, adminOnly, async (req, res) => {
  try {
    const { employeeId, month, year } = req.body;
    if (!employeeId || !month || !year)
      return res.status(400).json({ ok: false, error: 'Employee ID, month, and year required' });

    const payslip = await calculateSalary(employeeId, +year, +month);
    const doc = new PDFDocument({ size: 'A4', margin: 50 });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename=payslip_${payslip.employee.empId}_${year}_${month}.pdf`
    );
    doc.pipe(res);

    // Header Box
    doc
      .rect(50, 50, 500, 50)
      .fill('#0A3D62')
      .stroke()
      .fillColor('#FFFFFF')
      .fontSize(20)
      .text('SALARY SLIP', 0, 65, { align: 'center' })
      .fillColor('#000000');

    // Company + Month Info
    doc.moveDown(2);
    doc.fontSize(11).text(`Payroll Month: ${month}/${year}`, { align: 'right' });
    doc.moveDown(1);

    // Employee Information
    doc
      .fontSize(13)
      .text('Employee Details', { underline: true })
      .moveDown(0.8)
      .fontSize(11);
    const emp = payslip.employee;
    doc.text(`Employee Name: ${emp.name}`);
    doc.text(`Employee ID: ${emp.empId}`);
    doc.text(`Username: ${emp.username}`);
    doc.text(`Designation: ${emp.role === 'admin' ? 'Administrator' : 'Employee'}`);
    doc.moveDown(1.5);

    // Salary Table
    const tableTop = doc.y;
    const startX = 60;
    const column1Width = 250;
    const column2Width = 200;

    // Table header
    doc
      .fontSize(12)
      .fillColor('#0A3D62')
      .text('Earnings', startX, tableTop, { bold: true })
      .text('Amount (Rs.)', startX + column1Width, tableTop)
      .moveDown(0.8)
      .fillColor('#000000');

    // Divider line
    doc.moveTo(startX, tableTop + 15).lineTo(startX + 400, tableTop + 15).stroke();

    // Salary details
    let y = tableTop + 25;
    const details = [
      ['Base Monthly Salary', payslip.baseSalary],
      ['Per Day Salary', payslip.perDaySalary],
      ['Total Days in Month', payslip.totalDaysInMonth],
      ['Present Days', payslip.presentDays],
      ['Calculated Net Salary', payslip.calculatedSalary]
    ];

    details.forEach(([label, value]) => {
      doc.text(label, startX, y).text(value.toString(), startX + column1Width, y);
      y += 20;
    });

    // Highlight final salary
    doc
      .fontSize(13)
      .moveDown(1)
      .fillColor('#0A3D62')
      .text(`Net Payable Salary: Rs.${payslip.calculatedSalary}`, { align: 'center', underline: true });

    // Footer
    doc
      .fillColor('#555')
      .fontSize(10)
      .text('This is a computer-generated payslip. No signature required.', 0, 770, {
        align: 'center'
      });

    doc.end();
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

//------------------ EMPLOYEE LOGIN ------------------//
app.post('/employee/login', async (req, res) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({
        ok: false,
        error: 'Username and password required',
      });
    }

    const employee = await Employee.findOne({
      username,
      password,
      role: 'employee',
    }).select('-password');

    if (!employee) {
      return res.status(401).json({
        ok: false,
        error: 'Invalid employee credentials',
      });
    }

    res.json({
      ok: true,
      message: 'Employee login successful',
      user: employee,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

//------------------ EMPLOYEE SELF-SERVICE ------------------//

// Get Own Information
app.post('/employee/me', authenticate, employeeOnly, async (req, res) => {
  try {
    const employee = await Employee.findById(req.user._id)
      .select('-password')
      .lean();

    res.json({
      ok: true,
      employee,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// View Own Attendance
app.post(
  '/employee/attendance',
  authenticate,
  employeeOnly,
  async (req, res) => {
    try {
      const { month, year } = req.body;

      let query = { employee: req.user._id };

      if (month && year) {
        const from = startOfMonth(+year, +month);
        const to = endOfMonth(+year, +month);
        query.date = { $gte: from, $lte: to };
      }

      const attendance = await Attendance.find(query).sort({ date: -1 }).lean();

      const presentDays = attendance.filter(
        (a) => a.status === 'present'
      ).length;
      const absentDays = attendance.filter((a) => a.status === 'absent').length;

      res.json({
        ok: true,
        attendance,
        summary: {
          totalRecords: attendance.length,
          presentDays,
          absentDays,
        },
      });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  }
);

// View Own Payslip
app.post('/employee/payslip', authenticate, employeeOnly, async (req, res) => {
  try {
    const { month, year } = req.body;

    if (!month || !year) {
      return res.status(400).json({
        ok: false,
        error: 'Month and year required',
      });
    }

    const payslip = await calculateSalary(req.user._id, +year, +month);

    res.json({
      ok: true,
      payslip,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});
//------------------ EMPLOYEE PAYSLIP PDF (PROFESSIONAL FORMAT) ------------------//
app.post('/employee/payslip/pdf', authenticate, employeeOnly, async (req, res) => {
  try {
    const { month, year } = req.body;
    if (!month || !year)
      return res.status(400).json({ ok: false, error: 'Month and year required' });

    const payslip = await calculateSalary(req.user._id, +year, +month);
    const doc = new PDFDocument({ size: 'A4', margin: 50 });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename=my_payslip_${year}_${month}.pdf`
    );
    doc.pipe(res);

    // Header bar
    doc
      .rect(50, 50, 500, 50)
      .fill('#0A3D62')
      .stroke()
      .fillColor('#FFFFFF')
      .fontSize(20)
      .text('SALARY SLIP', 0, 65, { align: 'center' })
      .fillColor('#000000');

    // Payroll Info
    doc.moveDown(2);
    doc.fontSize(11).text(`Payroll Month: ${month}/${year}`, { align: 'right' });
    doc.moveDown(1);

    // Employee Information
    const emp = payslip.employee;
    doc
      .fontSize(13)
      .text('Employee Details', { underline: true })
      .moveDown(0.8)
      .fontSize(11);
    doc.text(`Employee Name: ${emp.name}`);
    doc.text(`Employee ID: ${emp.empId}`);
    doc.text(`Username: ${emp.username}`);
    doc.text(`Designation: ${emp.role === 'admin' ? 'Administrator' : 'Employee'}`);
    doc.moveDown(1.5);

    // Salary Table
    const tableTop = doc.y;
    const startX = 60;
    const column1Width = 250;

    // Table header
    doc
      .fontSize(12)
      .fillColor('#0A3D62')
      .text('Earnings', startX, tableTop, { bold: true })
      .text('Amount (Rs.)', startX + column1Width, tableTop)
      .moveDown(0.8)
      .fillColor('#000000');

    // Divider line
    doc.moveTo(startX, tableTop + 15).lineTo(startX + 400, tableTop + 15).stroke();

    // Salary details
    let y = tableTop + 25;
    const details = [
      ['Base Monthly Salary', payslip.baseSalary],
      ['Per Day Salary', payslip.perDaySalary],
      ['Total Days in Month', payslip.totalDaysInMonth],
      ['Present Days', payslip.presentDays],
      ['Calculated Net Salary', payslip.calculatedSalary]
    ];

    details.forEach(([label, value]) => {
      doc.text(label, startX, y).text(value.toString(), startX + column1Width, y);
      y += 20;
    });

    // Highlight final salary
    doc
      .fontSize(13)
      .moveDown(1)
      .fillColor('#0A3D62')
      .text(`Net Payable Salary: Rs.${payslip.calculatedSalary}`, { align: 'center', underline: true });

    // Footer
    doc
      .fillColor('#555')
      .fontSize(10)
      .text('This is a computer-generated payslip. No signature required.', 0, 770, {
        align: 'center'
      });

    doc.end();
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});


//------------------ SERVER START ------------------//
app.listen(PORT, () => {
  console.log('=================================');
  console.log('Payroll Management System');
  console.log(`Server running on port ${PORT}`);
  console.log('=================================');
});
//https://hrpayrollmanagementsystembackend.onrender.com
//hosted and currectly live
// flow
// first admin login with default credentials
// admin create employee
// admin can crud employee
// admin can mark attendence to a employee
// admin can generate payslip based on attendence
// employee get username password
// employee login
// employee can see all his informations alone

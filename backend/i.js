const axios = require('axios');
const base = 'http://localhost:10000';
(async () => {
  const report = [];
  try {
    // Health
    const health = await axios.get(base + '/');
    report.push({ name: 'Health', status: true, data: health.data });
    // Login
    const login = await axios.post(
      base + '/auth/login',
      { email: 'admin@pavakie.com', password: 'admin123' },
      { withCredentials: true }
    );
    const cookie = login.headers['set-cookie'];
    report.push({ name: 'Login', status: true, data: login.data });
    const headers = { Cookie: cookie };
    // Fetch Employees
    const emps = await axios.get(base + '/employees', {
      headers,
      withCredentials: true,
    });
    report.push({
      name: 'Fetch Employees',
      status: true,
      count: emps.data.employees.length,
      data: emps.data,
    });
    const empId = emps.data.employees.find((e) => e.role === 'employee')._id;
    // Attendance
    const att = await axios.post(
      base + '/attendance',
      { employee: empId, date: new Date(), status: 'present' },
      { headers, withCredentials: true }
    );
    report.push({ name: 'Attendance', status: true, data: att.data });
    // Salary Calculation
    const sal = await axios.get(
      `${base}/salary/generate?employeeId=${empId}&month=11&year=2025`,
      { headers, withCredentials: true }
    );
    report.push({ name: 'Salary Calculation', status: true, data: sal.data });
    // Salary PDF
    const pdf = await axios.get(
      `${base}/salary/pdf?employeeId=${empId}&month=11&year=2025`,
      { headers, responseType: 'arraybuffer' }
    );
    report.push({
      name: 'Salary PDF',
      status: pdf.status === 200,
      size: pdf.data.length,
    });
    console.log(
      'Final Detailed Report:\n',
      JSON.stringify(
        { ok: true, message: 'All API Tests Completed', results: report },
        null,
        2
      )
    );
  } catch (e) {
    console.error(
      JSON.stringify(
        { ok: false, message: 'Error testing APIs', error: e.message },
        null,
        2
      )
    );
  }
})();
